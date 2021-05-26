const path = require('path');

module.exports = {
  // rollup 配置
  libsOptions: [
    {
      cjs: { buildType: 'rollup' },
      pkgPath: path.resolve(__dirname, './packages/rollup'),
      entry: path.resolve(__dirname, './packages/rollup/src/rollup.js'),
      bundleName: 'index',
    },
  ],
};
