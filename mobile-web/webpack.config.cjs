const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
module.exports = {
  mode: 'production', context: __dirname, entry: './src/main.tsx',
  output: { path: path.join(__dirname, 'dist/bundle'), publicPath: './', filename: 'app.js', clean: true },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: { rules: [
    { test: /\.tsx?$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { configFile: path.join(__dirname, 'tsconfig.json') } } },
    { test: /\.s?css$|\.sass$/, use: [MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader'] }
  ] },
  plugins: [new HtmlWebpackPlugin({ template: './index.html' }), new MiniCssExtractPlugin({ filename: 'app.css' })],
  performance: { hints: false }, devtool: false,
};
