import { basename, dirname, extname, resolve } from 'path';
import { readFile, Promise } from 'sander';
import MagicString from 'magic-string';
import { keys, has } from './utils/object';
import Module from './Module';
import ExternalModule from './ExternalModule';
import finalisers from './finalisers/index';
import replaceIdentifiers from './utils/replaceIdentifiers';
import makeLegalIdentifier from './utils/makeLegalIdentifier';
import { defaultResolver } from './utils/resolvePath';

function badExports ( option, keys ) {
	throw new Error( `'${option}' was specified for options.exports, but entry module has following exports: ${keys.join(', ')}` );
}

export default class Bundle {
	constructor ( options ) {
		this.entryPath = resolve( options.entry ).replace( /\.js$/, '' ) + '.js';
		this.base = dirname( this.entryPath );

		this.resolvePath = options.resolvePath || defaultResolver;

		this.entryModule = null;
		this.modulePromises = {};
		this.statements = [];
		this.externalModules = [];
		this.defaultExportName = null;
		this.internalNamespaceModules = [];
	}

	fetchModule ( importee, importer ) {
		return Promise.resolve( importer === null ? importee : this.resolvePath( importee, importer ) )
			.then( path => {
				if ( !path ) {
					// external module
					if ( !has( this.modulePromises, importee ) ) {
						const module = new ExternalModule( importee );
						this.externalModules.push( module );
						this.modulePromises[ importee ] = Promise.resolve( module );
					}

					return this.modulePromises[ importee ];
				}

				if ( !has( this.modulePromises, path ) ) {
					this.modulePromises[ path ] = readFile( path, { encoding: 'utf-8' })
						.then( code => {
							const module = new Module({
								path,
								code,
								bundle: this
							});

							return module;
						});
				}

				return this.modulePromises[ path ];
			});
	}

	build () {
		// bring in top-level AST nodes from the entry module
		return this.fetchModule( this.entryPath, null )
			.then( entryModule => {
				this.entryModule = entryModule;

				if ( entryModule.exports.default ) {
					let defaultExportName = makeLegalIdentifier( basename( this.entryPath ).slice( 0, -extname( this.entryPath ).length ) );
					while ( entryModule.ast._scope.contains( defaultExportName ) ) {
						defaultExportName = `_${defaultExportName}`;
					}

					entryModule.suggestName( 'default', defaultExportName );
				}

				return entryModule.expandAllStatements( true );
			})
			.then( statements => {
				this.statements = statements;
				this.deconflict();
			});

	}

	deconflict () {
		let definers = {};
		let conflicts = {};

		// Discover conflicts (i.e. two statements in separate modules both define `foo`)
		this.statements.forEach( statement => {
			keys( statement._defines ).forEach( name => {
				if ( has( definers, name ) ) {
					conflicts[ name ] = true;
				} else {
					definers[ name ] = [];
				}

				// TODO in good js, there shouldn't be duplicate definitions
				// per module... but some people write bad js
				definers[ name ].push( statement._module );
			});
		});

		// Assign names to external modules
		this.externalModules.forEach( module => {
			// TODO is this right?
			let name = makeLegalIdentifier( module.suggestedNames['*'] || module.suggestedNames.default || module.id );

			if ( has( definers, name ) ) {
				conflicts[ name ] = true;
			} else {
				definers[ name ] = [];
			}

			definers[ name ].push( module );
			module.name = name;
		});

		// Rename conflicting identifiers so they can live in the same scope
		keys( conflicts ).forEach( name => {
			const modules = definers[ name ];

			modules.pop(); // the module closest to the entryModule gets away with keeping things as they are

			modules.forEach( module => {
				const replacement = getSafeName( name );
				module.rename( name, replacement );
			});
		});

		function getSafeName ( name ) {
			while ( has( conflicts, name ) ) {
				name = `_${name}`;
			}

			conflicts[ name ] = true;
			return name;
		}
	}

	generate ( options = {} ) {
		let magicString = new MagicString.Bundle({ separator: '' });

		// Determine export mode - 'default', 'named', 'none'
		let exportMode = this.getExportMode( options.exports );

		let previousMargin = 0;

		// Apply new names and add to the output bundle
		this.statements.forEach( statement => {
			let replacements = {};

			keys( statement._dependsOn )
				.concat( keys( statement._defines ) )
				.forEach( name => {
					const canonicalName = statement._module.getCanonicalName( name );

					if ( name !== canonicalName ) {
						replacements[ name ] = canonicalName;
					}
				});

			const source = statement._source.clone().trim();

			// modify exports as necessary
			if ( /^Export/.test( statement.type ) ) {
				// skip `export { foo, bar, baz }`
				if ( statement.type === 'ExportNamedDeclaration' && statement.specifiers.length ) {
					return;
				}

				// remove `export` from `export var foo = 42`
				if ( statement.type === 'ExportNamedDeclaration' && statement.declaration.type === 'VariableDeclaration' ) {
					source.remove( statement.start, statement.declaration.start );
				}

				// remove `export` from `export class Foo {...}` or `export default Foo`
				// TODO default exports need different treatment
				else if ( statement.declaration.id ) {
					source.remove( statement.start, statement.declaration.start );
				}

				else if ( statement.type === 'ExportDefaultDeclaration' ) {
					const module = statement._module;
					const canonicalName = module.getCanonicalName( 'default' );

					if ( statement.declaration.type === 'Identifier' && canonicalName === module.getCanonicalName( statement.declaration.name ) ) {
						return;
					}

					source.overwrite( statement.start, statement.declaration.start, `var ${canonicalName} = ` );
				}

				else {
					throw new Error( 'Unhandled export' );
				}
			}

			replaceIdentifiers( statement, source, replacements );

			// add leading comments
			if ( statement._leadingComments.length ) {
				const commentBlock = statement._leadingComments.map( comment => {
					return comment.block ?
						`/*${comment.text}*/` :
						`//${comment.text}`;
				}).join( '\n' );

				magicString.addSource( new MagicString( commentBlock ) );
			}

			// add margin
			const margin = Math.max( statement._margin[0], previousMargin );
			const newLines = new Array( margin ).join( '\n' );

			// add the statement itself
			magicString.addSource({
				content: source,
				separator: newLines
			});

			// add trailing comments
			const comment = statement._trailingComment;
			if ( comment ) {
				const commentBlock = comment.block ?
					` /*${comment.text}*/` :
					` //${comment.text}`;

				magicString.append( commentBlock );
			}

			previousMargin = statement._margin[1];
		});

		// prepend bundle with internal namespaces
		const indentString = magicString.getIndentString();
		const namespaceBlock = this.internalNamespaceModules.map( module => {
			const exportKeys = keys( module.exports );

			return `var ${module.getCanonicalName('*')} = {\n` +
				exportKeys.map( key => `${indentString}get ${key} () { return ${module.getCanonicalName(key)}; }` ).join( ',\n' ) +
			`\n};\n\n`;
		}).join( '' );

		magicString.prepend( namespaceBlock );

		const finalise = finalisers[ options.format || 'es6' ];

		if ( !finalise ) {
			throw new Error( `You must specify an output type - valid options are ${keys( finalisers ).join( ', ' )}` );
		}

		magicString = finalise( this, magicString.trim(), exportMode, options );

		return {
			code: magicString.toString(),
			map: magicString.generateMap({
				includeContent: true,
				file: options.dest
				// TODO
			})
		};
	}

	getExportMode ( exportMode ) {
		const exportKeys = keys( this.entryModule.exports );

		if ( exportMode === 'default' ) {
			if ( exportKeys.length !== 1 || exportKeys[0] !== 'default' ) {
				badExports( 'default', exportKeys );
			}
		} else if ( exportMode === 'none' && exportKeys.length ) {
			badExports( 'none', exportKeys );
		}

		if ( !exportMode || exportMode === 'auto' ) {
			if ( exportKeys.length === 0 ) {
				exportMode = 'none';
			} else if ( exportKeys.length === 1 && exportKeys[0] === 'default' ) {
				exportMode = 'default';
			} else {
				exportMode = 'named';
			}
		}

		if ( !/(?:default|named|none)/.test( exportMode ) ) {
			throw new Error( `options.exports must be 'default', 'named', 'none', 'auto', or left unspecified (defaults to 'auto')` );
		}

		return exportMode;
	}
}
