import { ethers } from "ethers";

export async function wait(
	provider: ethers.providers.Provider,
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