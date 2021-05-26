/**
 * eslint配置
 */
module.exports = {
  extends: require.resolve('@jianghe/sand-lint/node/prettier'),
  rules: {
    // 不考虑遍历定义顺序
    'no-use-before-define': [0],
    // 允许console
    'no-console': [0],
  },
};
