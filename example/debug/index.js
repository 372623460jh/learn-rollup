const { rollup } = require('@jianghe/rollup');

console.log(`输入：${__dirname}/demo/main.js`);
rollup(`${__dirname}/demo/main.js`).then((res) => {
  console.log(`输出：${__dirname}/demo/dist/bundle.js`);
  res.write(`${__dirname}/demo/bundle.js`);
});
