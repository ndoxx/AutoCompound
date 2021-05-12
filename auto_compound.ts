const chalk = require('chalk');
const https = require('https');
import { ethers } from "ethers";
import * as fs from 'fs';
import * as path from 'path';

import Pair from '@uniswap/v2-core/build/UniswapV2Pair.json';
import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json';
import UniswapV2Router from '@uniswap/v2-periphery/build/UniswapV2Router02.json';

const TOKEN_PRICE_DEVIATION = 0.3;
const EPSILON = ethers.utils.parseEther('0.0001');

async function wait(
	provider: any,
	hash: string,
	desc?: string,
	confirmation: number = 1
): Promise<void> {
	if (desc) {
		console.log(`> Waiting tx ${hash}\n    action = ${desc}`);
	} else {
		console.log(`> Waiting tx ${hash}`);
	}
	await provider.waitForTransaction(hash, confirmation);
}

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

function printBalance(
	address: string,
	etherBalance: ethers.BigNumber,
	etherSymbol: string,
	tokenBalance: ethers.BigNumber,
	tokenSymbol: string
) {
	console.log(`Wallet ${address} has:`);
	console.log(`    ${ethers.utils.formatEther(etherBalance)} ${etherSymbol}`);
	console.log(`    ${ethers.utils.formatEther(tokenBalance)} ${tokenSymbol}`);
}

async function fetchContract(
	address: string,
	scanAPI: string,
	apiKey: string,
	provider: any
): Promise<ethers.Contract> {
	// Check in abi folder if contract ABI is cached
	const filePath = path.join(__dirname, "abi", `${address}.abi.json`);
	let rawdata: string = "";
	try {
		if(fs.existsSync(filePath)) {
			console.log(chalk.yellow(`Fetching ABI for contract at ${address} (USING CACHE)`));
			rawdata = fs.readFileSync(filePath).toString();
		}
		else {
			console.log(chalk.yellow(`Fetching ABI for contract at ${address}`));
			// Get contract ABI as string using xxxscan API
			rawdata = await getContractABI(address, scanAPI, apiKey);
			// Save to JSON file for next time
			fs.writeFileSync(filePath, rawdata);
		}
	} catch(err) {
		console.error(err)
	}

	const ABI = JSON.parse(rawdata);
	return new ethers.Contract(address, ABI, provider);
}

async function main() {
	let tx;

	console.log(chalk.cyanBright.underline.bold("### AUTO-COMPOUND ###"));
	const config = require("./config.json");

	// TODO: for loop
	const pool = config.pools[0];
	console.log(`Pool: ${pool.name}`);

	// Connect to network
	console.log(chalk.yellow(`Connecting to network: ${pool.network}`));
	const networkInfo = config.networks[pool.network];
	const provider = new ethers.providers.JsonRpcProvider(networkInfo.url);
	const network = await provider.getNetwork();
	// Check chainId
	if(network.chainId != networkInfo.chainId) {
		throw new Error(chalk.red(`Invalid chainId: got ${networkInfo.chainId}, expected ${network.chainId}`));
	}

	// Connect wallet
	const privateKey = require("./secrets.json").privateKey;
	const wallet = new ethers.Wallet(privateKey, provider);

	// Get token & farm contracts
	const apiKey = require("./secrets.json").scan[pool.network].apiKey;
	const token = await fetchContract(pool.token, networkInfo.scanAPI, apiKey, provider);
	const farm = await fetchContract(pool.farm, networkInfo.scanAPI, apiKey, provider);

	const etherSymbol = networkInfo.symbol;
	const tokenSymbol = await token.symbol();

	// Get DEX
	const DEXInfo = config.DEX[pool.DEX];
    const factory = new ethers.Contract(DEXInfo.factory, UniswapV2Factory.abi, provider);
    const router = new ethers.Contract(DEXInfo.router, UniswapV2Router.abi, provider);
    const WETH = await router.WETH();
    const LP = await factory.getPair(token.address, WETH);
    const pair = new ethers.Contract(LP, Pair.abi, provider);
    console.log(`W${etherSymbol}: ${WETH}`);
    console.log(`W${etherSymbol}-${tokenSymbol}_LP: ${LP}`);

    const initialEtherBalance = await wallet.getBalance();
    const initialTokenBalance = await token.balanceOf(wallet.address);

	// Display wallet balance
	printBalance(
		wallet.address,
		initialEtherBalance,
		etherSymbol,
		initialTokenBalance,
		tokenSymbol
	);

	console.log(chalk.yellow("Harvesting rewards"));
	tx = await farm.connect(wallet).withdraw(pool.pid, 0);
	await wait(provider, tx.hash, "farm.withdraw");

    const afterClaimEtherBalance = await wallet.getBalance();
    const afterClaimTokenBalance = await token.balanceOf(wallet.address);
	const claimedTokens = afterClaimTokenBalance.sub(initialTokenBalance);

	console.log(chalk.green(`Claimed ${ethers.utils.formatEther(claimedTokens)} ${tokenSymbol}`));

	printBalance(
		wallet.address,
		afterClaimEtherBalance,
		etherSymbol,
		afterClaimTokenBalance,
		tokenSymbol
	);

	// Swap half of token balance for ether
	const tokensToSwap = claimedTokens.div(2);
	
	// Get pair reserves and estimate token price
	let etherReserve, tokenReserve;
	const reserves = await pair.getReserves();
	const token0 = await pair.token0();
	if(token0 == WETH) {
		etherReserve = reserves[0];
		tokenReserve = reserves[1];
	}
	else {
		etherReserve = reserves[1];
		tokenReserve = reserves[0];
	}

	etherReserve = parseFloat(ethers.utils.formatEther(etherReserve));
	tokenReserve = parseFloat(ethers.utils.formatEther(tokenReserve));
	const amount = parseFloat(ethers.utils.formatEther(tokensToSwap));
	const tokenPrice = etherReserve / tokenReserve;
	const amountOutMin = ethers.utils.parseEther((amount * tokenPrice * (1 - TOKEN_PRICE_DEVIATION)).toString());
	// const amountOutMin = ethers.utils.parseEther('0');

	console.log(`${etherSymbol} reserve: ${etherReserve}`);
	console.log(`${tokenSymbol} reserve: ${tokenReserve}`);
	console.log(`${tokenSymbol} price:   ${tokenPrice} ${etherSymbol}`);
	
	console.log(chalk.yellow(`Swapping ${ethers.utils.formatEther(tokensToSwap)} ${tokenSymbol} for at least ${ethers.utils.formatEther(amountOutMin)} ${etherSymbol}`));

	if(!pool.hasFees) {
		tx = await router.connect(wallet).swapExactTokensForETH(
			tokensToSwap,
			amountOutMin,
			[token.address, WETH],
			wallet.address,
			Math.floor(Date.now() / 1000) + 100,
			{gasLimit: 250000}
		);
		await wait(provider, tx.hash, `router.swapExactTokensForETH`);
	}
	else {
		tx = await router.connect(wallet).swapExactTokensForETHSupportingFeeOnTransferTokens(
			tokensToSwap,
			amountOutMin,
			[token.address, WETH],
			wallet.address,
			Math.floor(Date.now() / 1000) + 100,
			{gasLimit: 250000}
		);
		await wait(provider, tx.hash, `router.swapExactTokensForETHSupportingFeeOnTransferTokens`);
	}

    const afterSwapEtherBalance = await wallet.getBalance();
    const afterSwapTokenBalance = await token.balanceOf(wallet.address);

	// Retrieve ether amount
	const ethLiquidityAmount = afterSwapEtherBalance.sub(afterClaimEtherBalance);
	const tokLiquidityAmount = tokensToSwap.sub(EPSILON); // We swapped exactly half of reward

	console.log(chalk.green(`Got ${ethers.utils.formatEther(ethLiquidityAmount)} ${etherSymbol}`));

	printBalance(
		wallet.address,
		afterSwapEtherBalance,
		etherSymbol,
		afterSwapTokenBalance,
		tokenSymbol
	);

	// Add liquidity
	console.log(chalk.yellow("Adding liquidity"));
	tx = await token.connect(wallet).approve(router.address, tokLiquidityAmount); 
	await wait(provider, tx.hash, `${tokenSymbol}.approve`);

	tx = await router.connect(wallet).addLiquidityETH(
		token.address,
		tokLiquidityAmount, // desired tokens
		tokLiquidityAmount.mul(9000).div(10000), // min tokens
		ethLiquidityAmount.mul(9000).div(10000), // min eth
		wallet.address,
		Math.floor(Date.now() / 1000) + 60 * 10, // deadline
		{
			value: ethLiquidityAmount,
			gasLimit: 250000
		}
	);
	await wait(provider, tx.hash, `router.addLiquidityETH`);

	// Get LP balance
	const LPBalance = await pair.balanceOf(wallet.address);
	console.log(chalk.yellow(`Staking ${ethers.utils.formatEther(LPBalance)} LPs`));

	// Stake whole LP balance in pool
	tx = await pair.connect(wallet).approve(farm.address, LPBalance); 
	await wait(provider, tx.hash, `LPToken.approve`);

	// tx = await farm.connect(wallet).deposit(pool.pid, LPBalance); // DNW (farm.connect(wallet).deposit is not a function)
	tx = await farm.connect(wallet).functions['deposit(uint256,uint256)'](pool.pid, LPBalance);
	await wait(provider, tx.hash, `farm.deposit`);
}

main();
