const chalk = require('chalk');
const https = require('https');
import { ethers } from "ethers";
import * as fs from 'fs';
import * as path from 'path';

async function getContractABI(
	address: string,
	scanAPI: string,
	apiKey: string
): Promise<string> {
	const ABI: string = await new Promise((resolve, reject) => {
		https.get(`${scanAPI}api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`, (resp: any) => {
			let data = '';

			resp.on('data', (chunk: any) => {
				data += chunk;
			});

			resp.on('end', () => {
				const contractABI = JSON.parse(data).result;
				if (contractABI !== ''){
					resolve(contractABI);
				}
			});
		}).on("error", (err: any) => {
			console.log("Error: " + err.message);
			reject(err);
		});
	});

	if(ABI !== 'Contract source code not verified') {
		return ABI;
	}

	throw new Error('Contract source code not verified');
}

export async function fetchContractByAddress(
	address: string,
	networkInfo: any,
	apiKey: string,
	provider: any
): Promise<ethers.Contract> {
	// If network is localhost, look for a deployment in the test environment project
	if(networkInfo.name === 'localhost') {
		console.log(chalk.yellow(`Fetching deployment for contract at ${address}`));
		const deploymentsPath = path.join(__dirname, "../../../EthereumToolboxTestenv/deployments/localhost");
		if(!fs.existsSync(deploymentsPath)) 
			throw new Error(chalk.red('Unable to find localhost deployments in TestEnv project'));
		// Walk directory
		// TODO: Improve this when we have more contracts
		const files = fs.readdirSync(deploymentsPath);
		for(const file of files) {
			if(path.extname(file) === '.json') {
				const filepath = path.join(deploymentsPath, file);
				const deployment = require(filepath);
				if(deployment.address === address)
					return new ethers.Contract(address, deployment.abi, provider);
			}
		}
		throw new Error(chalk.red('Unable to find deployment for input address'));
	}

	// Check in abi folder if contract ABI is cached
	const filePath = path.join(__dirname, "../../data/abi", `${address}.abi.json`);
	let rawdata: string = "";
	try {
		if(fs.existsSync(filePath)) {
			console.log(chalk.yellow(`Fetching ABI for contract at ${address} (USING CACHE)`));
			rawdata = fs.readFileSync(filePath).toString();
		}
		else {
			console.log(chalk.yellow(`Fetching ABI for contract at ${address}`));
			// Get contract ABI as string using xxxscan API
			rawdata = await getContractABI(address, networkInfo.scanAPI, apiKey);
			// Save to JSON file for next time
			fs.writeFileSync(filePath, rawdata);
		}
	} catch(err) {
		console.error(err)
	}

	const ABI = JSON.parse(rawdata);
	return new ethers.Contract(address, ABI, provider);
}