const path = require('path')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
module.exports = ({ config }) => {

// Post CSS loader for sources:
config.module.rules.push({
  test: /\.css$/,
  include: path.resolve(__dirname, '../packages'),
  exclude: /(node_modules)/,
  use: [
    {
      loader: require.resolve('postcss-loader'),
      options: {
        // Set postcss.config.js config path && ctx 
        config: {
          path: '../postcss.config.js',
        },
        ident: 'postcss',
        plugins: () => [
          require('precss'),
          require('autoprefixer'),
          require('postcss-simple-vars'),
          require('postcss-nested'),
          require('postcss-import'),
          require('postcss-clean')(),
          require('postcss-flexbugs-fixes')
        ]
      }
    }
  ]
});

// TypeScript loader (via Babel to match polkadot/apps)
config.module.rules.push({
  test: /\.(ts|tsx)$/,
  exclude: /(node_modules)/,
  use: [
    {
      loader: require.resolve('babel-loader'),
      options: require('@polkadot/dev-react/config/babel')
    },
  ],
});
config.resolve.extensions.push('.ts', '.tsx');

// TSConfig, uses the same file as packages
config.resolve.plugins = config.resolve.plugins || [];
config.resolve.plugins.push(
  new TsconfigPathsPlugin({
    configFile: path.resolve(__dirname, '../tsconfig.json'),
  })
);

// Stories parser
config.module.rules.push({
    test: /\.stories\.tsx?$/,
    loaders: [require.resolve('@storybook/source-loader')],
    enforce: 'pre',
});

return config;
};
