/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      viaIR: true,  // IR pipeline reduces bytecode size; needed to stay under EIP-170 (24,576 byte) limit
      optimizer: {
        enabled: true,
        runs: 200
      },
      evmVersion: "paris"  // JOC doesn't support PUSH0 opcode yet (introduced in shanghai)
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
