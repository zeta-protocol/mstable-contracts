import { ForgeRewardsMUSDInstance, MUSDInstance } from "../../../types/generated";
import { applyRatioMassetToBasset, exactAmountToSimple, simpleToExactAmount } from "@utils/math";
import { BN } from "@utils/tools";
import TransactionDetails = Truffle.TransactionDetails;
import { BassetStatus } from "@utils/mstable-objects";
import { BassetInstance, BassetWithDecimals, OrderedBassets } from "./types";

export class ForgeRewardsMUSDMinter {
    constructor(
        public readonly forge: ForgeRewardsMUSDInstance,
        public readonly mUSD: MUSDInstance,
        public readonly bassets: OrderedBassets,
    ) {}

    public async approve(
        bassets = this.bassetAddresses,
        amount: BN,
        txDetails: TransactionDetails,
    ) {
        const decimals = await this.getDecimals(bassets);
        return Promise.all(
            bassets.map((address, index) =>
                this.getBassetByAddress(address).approve(
                    this.forge.address,
                    simpleToExactAmount(amount, decimals[index]),
                    txDetails,
                ),
            ),
        );
    }

    public async approveAllBassets(amount: BN, txDetails: TransactionDetails) {
        return this.approve(undefined, amount, txDetails);
    }

    public async mint(
        bassets = this.bassetAddresses,
        quantities: number[],
        musdRecipient: string,
        rewardRecipient: string,
        txDetails: TransactionDetails,
    ) {
        if (bassets.length !== quantities.length) {
            throw new Error("Expected the same number of bassets and quantities");
        }

        const bitmap = await this.getBitmap(bassets);
        const data = await this.getBassetsData(bassets);
        const decimalQuantities = quantities.map((amount, index) =>
            simpleToExactAmount(amount, data[index].decimals),
        );

        return this.forge.mintTo(
            bitmap,
            decimalQuantities,
            musdRecipient,
            rewardRecipient,
            txDetails,
        );
    }

    public async mintAllBassets(
        mintInput: BN,
        musdRecipient: string,
        rewardRecipient: string,
        txDetails: TransactionDetails,
    ) {
        const bitmap = await this.getBitmap(this.bassetAddresses);
        const quantities = await this.calcOptimalBassetQuantitiesForMint(mintInput);
        return this.forge.mintTo(bitmap, quantities, musdRecipient, rewardRecipient, txDetails);
    }

    public async getMUSDBalance(account: string) {
        const decimals = await this.mUSD.decimals();
        const amount = await this.mUSD.balanceOf(account);
        return exactAmountToSimple(amount, decimals);
    }

    private async getBassetsData(bassets = this.bassetAddresses) {
        const [addresses, keys, ratios, targets, vaults, statuses] = await this.mUSD.getBassets();
        const decimals = await this.getDecimals(bassets);
        return bassets.reduce(
            (data, _, index) => [
                ...data,
                {
                    addr: addresses[index],
                    key: keys[index],
                    ratio: ratios[index],
                    decimals: decimals[index],
                    maxWeight: targets[index],
                    vaultBalance: vaults[index],
                    status: BassetStatus[statuses[index].toNumber()],
                },
            ],
            [] as BassetWithDecimals[],
        );
    }

    private async calcOptimalBassetQuantitiesForMint(mintInput: BN) {
        const massetDecimals = await this.mUSD.decimals();
        const mintInputExact = simpleToExactAmount(mintInput, massetDecimals.toNumber());
        const data = await this.getBassetsData(this.bassetAddresses);
        return data.map(({ decimals, maxWeight, ratio }, i) => {
            // 1e18 Massets
            // 1e18 * ratioScale = 1e26
            // if Ratio == 1e8 then its straight up
            // if Ratio == 1e12 then that means decimals = 4
            // maxWeight == 40% == 40e16
            // convertExactToSimple divides by 1e18
            // this creates an exact percentage amount
            const relativeUnitsToMint = exactAmountToSimple(mintInputExact.mul(maxWeight), 18);
            return applyRatioMassetToBasset(relativeUnitsToMint, ratio);
        });
    }

    private async getBitmap(bassets = this.bassetAddresses): Promise<number> {
        const bitmap = await this.mUSD.getBitmapFor(bassets);
        return bitmap.toNumber();
    }

    private async getDecimals(bassets = this.bassetAddresses): Promise<number[]> {
        const decimals = await Promise.all(
            bassets.map((address) => this.getBassetByAddress(address).decimals()),
        );
        return decimals.map((bn) => bn.toNumber());
    }

    private getBassetByAddress(address: string): BassetInstance {
        const basset = this.bassets.find((b) => b.address === address);
        if (!basset) {
            throw new Error(`Basset with address ${address} not found`);
        }
        return basset;
    }

    public get bassetAddresses(): string[] {
        return this.bassets.map((basset) => basset.address);
    }
}