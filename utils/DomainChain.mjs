import {Config} from "epistery";
import ethers from "ethers";
import path from 'path';
import { readFileSync } from 'fs';
import {createRequire} from "module";
import {fileURLToPath} from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DomainChain {
  constructor(domain) {
    this.domain = domain;
    this.config = new Config();
    this.config.setPath(domain);
  }
  get provider() {
    if (!this._provider) {
      this._provider = new ethers.providers.JsonRpcProvider(this.config.data.provider.rpc, {
        chainId: parseInt(this.config.data.provider.chainId),
        name: this.config.data.provider.name
      });
    }
    return this._provider;
  }
  get contract() {
    if (!this._contract) {
      this.contractAddress = this.config.data.contract_address;
      if (!this.contractAddress) return null;
      this.artifact = JSON.parse(
        readFileSync(path.join(__dirname, '../artifacts/contracts/DomainAgent.sol/DomainAgent.json'), 'utf8')
      );
      const wallet = ethers.Wallet.fromMnemonic(this.config.data.wallet.mnemonic).connect(this.provider);
      this._contract = new ethers.Contract(this.contractAddress, this.artifact.abi, wallet);
    }
    return this._contract;
  }
  async getFeeData() {
    const feeData = await this.provider.getFeeData();
    // Get gas prices with minimum
    const minGasPrice = ethers.utils.parseUnits("30", "gwei");
    const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
    const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
    const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
    const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);
    return { maxPriorityFeePerGas, maxFeePerGas }
  }
}
