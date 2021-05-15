const chalk = require('chalk');
const https = require('https');

import Pair from '@uniswap/v2-core/build/UniswapV2Pair.json';
import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json';
import UniswapV2Router from '@uniswap/v2-periphery/build/UniswapV2Router02.json';
import { ethers } from "ethers";

import * as math from '../common/math-utils'
import { wait } from '../common/ether-utils'

const GAS_LIMIT_SWAP_TOKEN_ETH = 200000;
const GAS_LIMIT_ADD_LIQUIDITY  = 250000;

const IERC20ABI = [
	"function name() view returns(string)",
	"function symbol() view returns(string)"
];

export class Uniswap {
	public Ready: Promise<void>;
	public WETH!: string;
	public factory!: ethers.Contract;
	public router!: ethers.Contract;
	provider: ethers.providers.Provider;
	slippage: number;

	constructor (
		provider: ethers.providers.Provider,
		routerAddress: string
	) {
		this.provider = provider;
		this.slippage = 0.01;

		this.Ready = new Promise(async (resolve, reject) => {
			this.router = new ethers.Contract(routerAddress, UniswapV2Router.abi, this.provider);
			const factoryAddress = await this.router.factory();
			this.factory = new ethers.Contract(factoryAddress, UniswapV2Factory.abi, this.provider);
			this.WETH = await this.router.WETH();
			console.log(`[U] Uniswap DEX controller created.`);
			console.log(`[U]    factory: ${this.factory.address}`);
			console.log(`[U]    router:  ${this.router.address}`);
			console.log(`[U]    WETH:    ${this.WETH}`);
			resolve();
		});
	}

	setSlippage(_slippage: number) {
		this.slippage = math.clamp(_slippage, 0, 1);
		console.log(`[U] Set slippage tolerance to: ${this.slippage * 100}%`);
	}

	async getPair(
		tokenA: string,
		tokenB: string
	): Promise<ethers.Contract> {
		const LP = await this.factory.getPair(tokenA, tokenB);
		return new ethers.Contract(LP, Pair.abi, this.provider);
	}

	async getPairSymbol(
		pair: ethers.Contract
	): Promise<string> {
		const token0 = await pair.token0();
		const token1 = await pair.token1();
		const t0 = new ethers.Contract(token0, IERC20ABI, this.provider);
		const t1 = new ethers.Contract(token1, IERC20ABI, this.provider);
		const token0Symbol = await t0.symbol();
		const token1Symbol = await t1.symbol();
		const LPSymbol = await pair.symbol();
		return `[${token0Symbol}]-[${token1Symbol}]_${LPSymbol}`;
	}

	async getReserves(
		tokenA: string,
		tokenB: string
	): Promise<Array<number>> {
		const pair = await this.getPair(tokenA, tokenB);

		let reserveB, reserveA;
		const reserves = await pair.getReserves();
		const token0 = await pair.token0();
		if(token0 == tokenA)
			return [reserves[0], reserves[1]];
		return [reserves[1], reserves[0]];
	}

	async getTokenPrice(
		tokenA: string,
		tokenB: string
	): Promise<number> {
		const reserves = await this.getReserves(tokenA, tokenB);
		return parseFloat(ethers.utils.formatEther(reserves[1])) / parseFloat(ethers.utils.formatEther(reserves[0]));
	}

	async sellToken(
		token: ethers.Contract,
		amount: ethers.BigNumber,
		wallet: ethers.Wallet,
		supportFees: boolean = false
	): Promise<void> {
		let tx;

		const WETH = await this.router.WETH();
		const tokenSymbol = await token.symbol();

		const tokenPrice = await this.getTokenPrice(token.address, WETH);
		const amountAsNumber = parseFloat(ethers.utils.formatEther(amount));
		const amountOutMin = ethers.utils.parseEther((amountAsNumber * tokenPrice * (1 - this.slippage)).toString());

		console.log(`[U] Selling ${ethers.utils.formatEther(amount)} ${tokenSymbol} for at least ${ethers.utils.formatEther(amountOutMin)}E`);
		
		if(!supportFees) {
			tx = await this.router.connect(wallet).swapExactTokensForETH(
				amount,
				amountOutMin,
				[token.address, WETH],
				wallet.address,
				Math.floor(Date.now() / 1000) + 100,
				{
					gasLimit: GAS_LIMIT_SWAP_TOKEN_ETH
				}
			);
			await wait(this.provider, tx.hash, "UniswapV2Router02::swapExactTokensForETH");
		}
		else {
			tx = await this.router.connect(wallet).swapExactTokensForETHSupportingFeeOnTransferTokens(
				amount,
				amountOutMin,
				[token.address, WETH],
				wallet.address,
				Math.floor(Date.now() / 1000) + 100,
				{
					gasLimit: GAS_LIMIT_SWAP_TOKEN_ETH
				}
			);
			await wait(this.provider, tx.hash, "UniswapV2Router02::swapExactTokensForETHSupportingFeeOnTransferTokens");
		}
	}

	async addLiquidity(
		token: ethers.Contract,
		tokenAmount: ethers.BigNumber,
		ethAmount: ethers.BigNumber,
		wallet: ethers.Wallet,
	): Promise<ethers.BigNumber> {
		let tx;

		const tokenSymbol = await token.symbol();
		const slippageFactor = ethers.BigNumber.from((1 - this.slippage) * 10000);
		const tokenAmountMin = tokenAmount.mul(slippageFactor).div(10000);
		const ethAmountMin = ethAmount.mul(slippageFactor).div(10000);

		console.log(`[U] Adding liquidity comprised of: (${ethers.utils.formatEther(tokenAmount)} ${tokenSymbol}, ${ethers.utils.formatEther(ethAmount)}E)`);

		// This method will wait for a Transfer event before it returns,
		// it is much longer but arguably safer than computing a before-after
		// balance difference to obtain the minted LP amount
		const pair = await this.getPair(token.address, this.WETH);
		const LPAmountPromise = new Promise<ethers.BigNumber>((resolve, reject) => {
			pair.on("Transfer", (from, to, value) => {
				if(to === wallet.address) {
					resolve(value);
				}
			});

			setTimeout(() => { reject(new Error('timeout')); }, 20000); // 20s timeout
		});

		tx = await this.router.connect(wallet).addLiquidityETH(
			token.address,
			tokenAmount, 	// desired tokens
			tokenAmountMin, // min tokens
			ethAmountMin,   // min eth
			wallet.address,
			Math.floor(Date.now() / 1000) + 100,  // deadline
			{
				value: ethAmount,
				gasLimit: GAS_LIMIT_ADD_LIQUIDITY
			}
		);
		await wait(this.provider, tx.hash, "UniswapV2Router02::addLiquidityETH");

		const LPSymbol = await this.getPairSymbol(pair);
		const LPAmount = await LPAmountPromise;

		console.log(chalk.green(`Received ${ethers.utils.formatEther(LPAmount)} ${LPSymbol}`));
		return LPAmount;
	}

	async printPoolInfo(
		tokenA: string,
		tokenB: string
	): Promise<void> {
		const pairAddress = await this.factory.getPair(tokenA, tokenB);
		const pair = new ethers.Contract(pairAddress, Pair.abi, this.provider);
		const t0 = new ethers.Contract(tokenA, IERC20ABI, this.provider);
		const t1 = new ethers.Contract(tokenB, IERC20ABI, this.provider);
		const token0Symbol = await t0.symbol();
		const token1Symbol = await t1.symbol();
		const LPSymbol = await pair.symbol();
		const fullLPSymbol = `[${token0Symbol}]-[${token1Symbol}]_${LPSymbol}`;

		const reserves = await this.getReserves(tokenA, tokenB);
		const tokenPrice = parseFloat(ethers.utils.formatEther(reserves[1])) / parseFloat(ethers.utils.formatEther(reserves[0]));

		console.log('[U] Pool info:');
		console.log(`[U]    ${fullLPSymbol} address: ${pairAddress}`);
		console.log(`[U]    ${token0Symbol} reserve: ${ethers.utils.formatEther(reserves[0])}`);
		console.log(`[U]    ${token1Symbol} reserve: ${ethers.utils.formatEther(reserves[1])}`);
		console.log(`[U]    ${token0Symbol} price:   ${tokenPrice} ${token1Symbol}`);
	}
}
