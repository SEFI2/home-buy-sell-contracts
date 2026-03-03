require('@nomiclabs/hardhat-waffle');

module.exports = {
  solidity: {
    version: '0.5.17',
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};
