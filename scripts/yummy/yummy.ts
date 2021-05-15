const chalk = require('chalk');
const https = require('https');
import { ethers } from "ethers";
import * as fs from 'fs';
import * as path from 'path';

import * as math from '../common/math-utils'
import { Uniswap } from '../common/uniswap-utils'
import { fetchContractByAddress } from '../common/contract-utils'
import { wait } from '../common/ether-utils'

const EPSILON = ethers.utils.parseEther('0.0001');
const GAS_LIMIT = 250000;


function printBalance(
	address: string,
	etherBalance: ethers.BigNumber,
	etherSymbol: string,
	tokenBalance: ethers.BigNumber,
	tokenSymbol: string
) {
	console.log(`Wallet ${address} balance:`);

	const balanceInfo = [
		[etherSymbol, ethers.utils.formatEther(etherBalance)],
		[tokenSymbol, ethers.utils.formatEther(tokenBalance)]
	];
	console.table(balanceInfo);
}

async function main() {
	let tx;

	console.log(chalk.cyanBright.underline.bold("### YUMMY::AUTO-COMPOUND ###"));
	const config = require(path.join(__dirname, "../../config/yummy.json"));
	const configCommon = require(path.join(__dirname, "../../config/common.json"));
	const secrets = require(path.join(__dirname, "../../config/secrets.json"));

	let SLIPPAGE_TOLERANCE = math.clamp(config.global.slippageTolerance, 0, 1);

	// TODO: parameterize this
	const pool = config.pools[1];


	console.log(`Pool: ${pool.name}`);

	if(pool.hasOwnProperty('slippageTolerance')) {
		SLIPPAGE_TOLERANCE = math.clamp(pool.slippageTolerance, 0, 1);
	}

	let f0 = 0;
	if(pool.hasOwnProperty('profitFraction')) {
		f0 = math.clamp(pool.profitFraction, 0, 1);
	}
	const SWAP_FRACTION = ethers.BigNumber.from(Math.floor(0.5 * (1 + f0) * 10000));
	const LIQUIDITY_ETHER_FRACTION = ethers.BigNumber.from(Math.floor((1 - f0) / (1 + f0) * 10000));

	// Connect to network
	console.log(chalk.yellow(`Connecting to network: ${pool.network}`));
	const networkInfo = configCommon.networks[pool.network];
	const provider = new ethers.providers.JsonRpcProvider(networkInfo.url);
	const network = await provider.getNetwork();
	// Check chainId
	if(network.chainId != networkInfo.chainId) {
		throw new Error(chalk.red(`Invalid chainId: got ${networkInfo.chainId}, expected ${network.chainId}`));
	}

	// Connect wallet
	const privateKey = secrets[pool.network].privateKey;
	const wallet = new ethers.Wallet(privateKey, provider);

	// Get token & farm contracts
	const apiKey = secrets[pool.network].scanAPIKey;
	const token = await fetchContractByAddress(pool.token, networkInfo, apiKey, provider);
	const farm = await fetchContractByAddress(pool.farm, networkInfo, apiKey, provider);

	const etherSymbol = networkInfo.symbol;
	const tokenSymbol = await token.symbol();

	// Get DEX
	const DEXInfo = networkInfo.DEX[pool.DEX];
	const dex = new Uniswap(provider, DEXInfo.router);
	await dex.Ready;
	dex.setSlippage(SLIPPAGE_TOLERANCE);


	// ### INFO ###
	await dex.printPoolInfo(token.address, dex.WETH);

	// Display wallet balance
	const initialEtherBalance = await wallet.getBalance();
	const initialTokenBalance = await token.balanceOf(wallet.address);

	printBalance(
		wallet.address,
		initialEtherBalance,
		etherSymbol,
		initialTokenBalance,
		tokenSymbol
	);


	// ### HARVEST ###
	console.log(chalk.yellow("* Harvesting rewards"));
	tx = await farm.connect(wallet).withdraw(pool.pid, 0, { gasLimit: GAS_LIMIT });
	await wait(provider, tx.hash, "farm.withdraw");

	const afterClaimEtherBalance = await wallet.getBalance();
	const afterClaimTokenBalance = await token.balanceOf(wallet.address);
	const claimedTokens = afterClaimTokenBalance.sub(initialTokenBalance);

	console.log(chalk.green(`Received ${ethers.utils.formatEther(claimedTokens)} ${tokenSymbol}`));


	// ### SWAP ###
	// Swap half of token balance for ether
	console.log(chalk.yellow(`* Swapping tokens`));
	const tokensToSwap = afterClaimTokenBalance.mul(SWAP_FRACTION).div(10000);
	
	// Approval: all claimed tokens are spent by router, during swap and then when adding liquidity
	tx = await token.connect(wallet).approve(dex.router.address, afterClaimTokenBalance); 
	await wait(provider, tx.hash, `${tokenSymbol}.approve`);

	// Swap
	await dex.sellToken(
		token,
		tokensToSwap,
		wallet,
		pool.hasFees
	);

	const afterSwapEtherBalance = await wallet.getBalance();
	const afterSwapTokenBalance = await token.balanceOf(wallet.address);

	if(afterSwapEtherBalance < afterClaimEtherBalance) {
		throw new Error(chalk.red('Swap failed'));
	}

	// Retrieve ether amount
	const ethReceived = afterSwapEtherBalance.sub(afterClaimEtherBalance);
	console.log(chalk.green(`Received ${ethers.utils.formatEther(ethReceived)} ${etherSymbol}`));


	// If afterSwapTokenBalance is null, we got everything out for profit, so there is nothing left to compound
	if(afterSwapTokenBalance <= EPSILON) {
		console.log(chalk.yellow("Nothing left to compound"));

		printBalance(
			wallet.address,
			await wallet.getBalance(),
			etherSymbol,
			await token.balanceOf(wallet.address),
			tokenSymbol
		);

		return;
	}

	// ### LIQUIDITY ###
	console.log(chalk.yellow("* Adding liquidity"));

	const ethLiquidityAmount = ethReceived.mul(LIQUIDITY_ETHER_FRACTION).div(10000);
	const tokLiquidityAmount = afterSwapTokenBalance.sub(EPSILON);

	const LPAmount = await dex.addLiquidity(
		token,
		tokLiquidityAmount,
		ethLiquidityAmount,
		wallet
	);
	

	// ### RESTAKE ###
	console.log(chalk.yellow(`* Staking all LPs`));

	// Stake whole LP balance in pool
	const pair = await dex.getPair(token.address, dex.WETH);
	tx = await pair.connect(wallet).approve(farm.address, LPAmount); 
	await wait(provider, tx.hash, `LPToken.approve`);

	// tx = await farm.connect(wallet).deposit(pool.pid, LPAmount); // DNW (farm.connect(wallet).deposit is not a function)
	tx = await farm.connect(wallet).functions['deposit(uint256,uint256)'](pool.pid, LPAmount);
	await wait(provider, tx.hash, `farm.deposit`);


	const afterStakeEtherBalance = await wallet.getBalance();
	const afterStakeTokenBalance = await token.balanceOf(wallet.address);

	printBalance(
		wallet.address,
		afterStakeEtherBalance,
		etherSymbol,
		afterStakeTokenBalance,
		tokenSymbol
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});