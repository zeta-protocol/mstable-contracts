/* eslint-disable no-console */
import "ts-node/register"
import "tsconfig-paths/register"

import { btcBassets, startingCap, capFactor, config, mBtcName, mBtcSymbol, DeployedBasset } from "@utils/btcConstants"
import { DEAD_ADDRESS, ZERO_ADDRESS } from "@utils/constants"
import { Signer } from "ethers"
import { task } from "hardhat/config"
import { formatEther } from "ethers/lib/utils"
import {
    SavingsContract,
    Masset,
    Masset__factory,
    InvariantValidator__factory,
    AssetProxy__factory,
    MockERC20,
    MockERC20__factory,
    MockInitializableToken__factory,
    SavingsContract__factory,
    BoostedSavingsVault__factory,
    BoostedSavingsVault,
    ERC20__factory,
    SaveWrapper__factory,
    RenWrapper__factory,
} from "types/generated"
import { simpleToExactAmount, BN } from "@utils/math"

interface CommonAddresses {
    mta: string
    staking: string
    nexus: string
    proxyAdmin: string
    rewardsDistributor: string
    uniswap: string
    poker: string
    renGatewayRegistry: string
}

const deployBasset = async (sender: Signer, name: string, symbol: string, decimals = 18, initialMint = 500000): Promise<MockERC20> => {
    // Implementation
    const impl = await new MockInitializableToken__factory(sender).deploy()
    await impl.deployTransaction.wait()

    // Initialization Data
    const data = impl.interface.encodeFunctionData("initialize", [name, symbol, decimals, await sender.getAddress(), initialMint])
    // Proxy
    const proxy = await new AssetProxy__factory(sender).deploy(impl.address, DEAD_ADDRESS, data)
    const receipt = await proxy.deployTransaction.wait()

    console.log(`Deployed ${name} (${symbol}) to address ${proxy.address}. gas used ${receipt.gasUsed}`)

    return new MockERC20__factory(sender).attach(proxy.address)
}

const deployMasset = async (sender: Signer, addresses: CommonAddresses, ethers, bAssetContracts: DeployedBasset[]): Promise<Masset> => {
    // Invariant Validator
    console.log(`Deploying Invariant Validator with startingCap ${startingCap.toString()} and capfactor ${capFactor.toString()}`)
    const forgeVal = await new InvariantValidator__factory(sender).deploy(startingCap, capFactor)
    const receiptForgeVal = await forgeVal.deployTransaction.wait()
    console.log(`Deployed Invariant Validator to ${forgeVal.address}. gas used ${receiptForgeVal.gasUsed}`)

    // External linked library
    const Manager = await ethers.getContractFactory("Manager")
    const managerLib = await Manager.deploy()
    const receiptManager = await managerLib.deployTransaction.wait()
    console.log(`Deployed Manager library to ${managerLib.address}. gas used ${receiptManager.gasUsed}`)

    const linkedAddress = {
        __$1a38b0db2bd175b310a9a3f8697d44eb75$__: managerLib.address,
    }
    // Implementation
    const massetFactory = new Masset__factory(linkedAddress, sender)
    const size = massetFactory.bytecode.length / 2 / 1000
    if (size > 24.576) {
        console.error(`Masset size is ${size} kb: ${size - 24.576} kb too big`)
    } else {
        console.log(`Masset = ${size} kb`)
    }
    console.log(`Deploying Masset with ManagerAddr: ${managerLib.address} and nexus ${addresses.nexus}`)
    const impl = await massetFactory.deploy(addresses.nexus)
    const receiptImpl = await impl.deployTransaction.wait()
    console.log(`Deployed Masset to ${impl.address}. gas used ${receiptImpl.gasUsed}`)

    // Initialization Data
    console.log(
        `Initializing Masset with: ${mBtcName}, ${mBtcSymbol}, ${forgeVal.address}, [${bAssetContracts.map(
            // eslint-disable-next-line
            (b) => "{" + b.contract.address + ", " + b.integrator + ", " + b.txFee + ", " + 0 + "}",
        )} ] , ${config.a.toString()}, ${config.limits.min.toString()}, ${config.limits.max.toString()}`,
    )
    const data = impl.interface.encodeFunctionData("initialize", [
        mBtcName,
        mBtcSymbol,
        forgeVal.address,
        bAssetContracts.map((b) => ({
            addr: b.contract.address,
            integrator: b.integrator,
            hasTxFee: b.txFee,
            status: 0,
        })),
        config,
    ])
    // Proxy
    console.log(`Deploying mBTC proxy with impl: ${impl.address} and admin ${addresses.proxyAdmin}`)
    const mBtcProxy = await new AssetProxy__factory(sender).deploy(impl.address, addresses.proxyAdmin, data)
    const receiptProxy = await mBtcProxy.deployTransaction.wait()

    console.log(`Deployed mBTC to address ${mBtcProxy.address}. gas used ${receiptProxy.gasUsed}`)

    if (addresses.renGatewayRegistry !== DEAD_ADDRESS) {
        const gateway = await new RenWrapper__factory(sender).deploy(mBtcProxy.address, addresses.renGatewayRegistry)
        const receiptGateway = await gateway.deployTransaction.wait()
        console.log(`Deployed Ren Gateway wrapper to address ${gateway.address}. gas used ${receiptGateway.gasUsed}`)
    }

    // Create a Masset contract pointing to the deployed proxy contract
    return new Masset__factory(linkedAddress, sender).attach(mBtcProxy.address)
}

const mint = async (sender: Signer, bAssets: DeployedBasset[], mBTC: Masset) => {
    // Mint 3/5 of starting cap
    const scaledTestQty = startingCap.div(5)

    // Approve spending
    // eslint-disable-next-line
    for (const bAsset of bAssets) {
        // eslint-disable-next-line
        const tx = await bAsset.contract.approve(mBTC.address, scaledTestQty)
        // eslint-disable-next-line
        const receiptApprove = await tx.wait()
        console.log(
            // eslint-disable-next-line
            `Approved mBTC to transfer ${formatEther(scaledTestQty)} ${bAsset.symbol} from ${await sender.getAddress()}. gas used ${
                receiptApprove.gasUsed
            }`,
        )
    }

    // Mint
    const tx = await mBTC.mintMulti(
        bAssets.map((b) => b.contract.address),
        bAssets.map(() => scaledTestQty),
        1,
        await sender.getAddress(),
    )
    const receiptMint = await tx.wait()

    // Log minted amount
    const mAssetAmount = formatEther(await mBTC.totalSupply())
    console.log(`Minted ${mAssetAmount} mBTC from ${formatEther(scaledTestQty)} BTC for each bAsset. gas used ${receiptMint.gasUsed}`)
}

interface SaveContracts {
    savingContract: SavingsContract
    savingsVault: BoostedSavingsVault
}

const deploySave = async (
    sender: Signer,
    addresses: CommonAddresses,
    mBTC: Masset,
    bAssets: Array<string>,
    deployVault = true,
): Promise<SaveContracts> => {
    // Save impl
    console.log(`Deploying Savings Contract nexus: ${addresses.nexus} and underlying ${mBTC.address}`)
    const sImpl = await new SavingsContract__factory(sender).deploy(addresses.nexus, mBTC.address)
    const receiptSaving = await sImpl.deployTransaction.wait()
    console.log(`Deployed Savings contract to ${sImpl.address}. gas used ${receiptSaving.gasUsed}`)

    // Data
    const sData = sImpl.interface.encodeFunctionData("initialize", [addresses.poker, "Interest bearing mStable BTC", "imBTC"])
    // Proxy
    console.log(`Deploying Savings Contract proxy, impl: ${sImpl.address}, admin: ${addresses.proxyAdmin}`)
    const sProxy = await new AssetProxy__factory(sender).deploy(sImpl.address, addresses.proxyAdmin, sData)
    const receiptProxy = await sProxy.deployTransaction.wait()
    const savingContract = await new SavingsContract__factory(sender).attach(sProxy.address)
    console.log(`Deployed Saving Proxy to ${sProxy.address}. gas used ${receiptProxy.gasUsed}`)

    // Vault impl
    if (deployVault) {
        const vImpl = await new BoostedSavingsVault__factory(sender).deploy(
            addresses.nexus,
            savingContract.address,
            addresses.staking,
            simpleToExactAmount(3000, 18),
            addresses.mta,
        )
        const receiptVaultImpl = await vImpl.deployTransaction.wait()
        console.log(`Deployed Vault Impl to ${sProxy.address}. gas used ${receiptVaultImpl.gasUsed}`)

        // Data
        const vData = vImpl.interface.encodeFunctionData("initialize", [addresses.rewardsDistributor])
        // Proxy
        const vProxy = await new AssetProxy__factory(sender).deploy(vImpl.address, addresses.proxyAdmin, vData)
        const receiptVaultProxy = await vProxy.deployTransaction.wait()
        const savingsVault = await new BoostedSavingsVault__factory(sender).attach(vProxy.address)
        console.log(`Deployed Vault Proxy to ${vProxy.address}. gas used ${receiptVaultProxy.gasUsed}`)

        // SaveWrapper
        const wrapper = await new SaveWrapper__factory(sender).deploy(
            savingContract.address,
            savingsVault.address,
            mBTC.address,
            bAssets,
            addresses.uniswap,
        )
        const receiptSavingWrapper = await wrapper.deployTransaction.wait()
        console.log(`Deployed Savings Wrapper to address ${wrapper.address}. gas used ${receiptSavingWrapper.gasUsed}`)

        return { savingContract, savingsVault }
    }
    // SaveWrapper
    console.log(`Deploying Wrapper...`)
    const wrapper = await new SaveWrapper__factory(sender).deploy(
        savingContract.address,
        DEAD_ADDRESS,
        mBTC.address,
        bAssets,
        addresses.uniswap,
    )
    const receiptSavingWrapper = await wrapper.deployTransaction.wait()
    console.log(`Deployed Savings Wrapper to address ${wrapper.address}. gas used ${receiptSavingWrapper.gasUsed}`)

    return { savingContract, savingsVault: null }
}

const depositToVault = async (sender: Signer, mBTC: Masset, save: SaveContracts): Promise<void> => {
    // Mint imBTC
    const deposit = startingCap.div(BN.from(3))
    let tx = await mBTC.approve(save.savingContract.address, deposit)
    await tx.wait()
    tx = await save.savingContract.preDeposit(deposit, await sender.getAddress())
    await tx.wait()
    const balance = await save.savingContract.balanceOf(await sender.getAddress())

    // Deposit to vault
    tx = await save.savingContract.approve(save.savingsVault.address, balance)
    await tx.wait()
    tx = await save.savingsVault["stake(uint256)"](balance)
    tx.wait()

    console.log(`Minted ${formatEther(balance)} imBTC from ${formatEther(deposit)} mBTC and deposited to vault`)
}

task("deployMBTC", "Deploys the mBTC contracts").setAction(async (_, hre) => {
    const { ethers, network } = hre
    const [deployer] = await ethers.getSigners()

    const addresses =
        network.name === "ropsten"
            ? {
                  mta: "0x273bc479E5C21CAA15aA8538DecBF310981d14C0",
                  staking: "0x77f9bf80e0947408f64faa07fd150920e6b52015",
                  nexus: "0xeD04Cd19f50F893792357eA53A549E23Baf3F6cB",
                  proxyAdmin: "0x2d369F83E9DC764a759a74e87a9Bc542a2BbfdF0",
                  rewardsDistributor: "0x99B62B75E3565bEAD786ddBE2642E9c40aA33465",
                  uniswap: DEAD_ADDRESS,
                  poker: DEAD_ADDRESS,
                  renGatewayRegistry: DEAD_ADDRESS,
              }
            : {
                  mta: DEAD_ADDRESS,
                  staking: (await new MockERC20__factory(deployer).deploy("Stake", "ST8", 18, DEAD_ADDRESS, 1)).address,
                  nexus: DEAD_ADDRESS,
                  proxyAdmin: DEAD_ADDRESS,
                  rewardsDistributor: DEAD_ADDRESS,
                  uniswap: DEAD_ADDRESS,
                  poker: DEAD_ADDRESS,
                  renGatewayRegistry: DEAD_ADDRESS,
              }

    // 1. Deploy bAssets
    const bAssets: DeployedBasset[] = []
    // eslint-disable-next-line
    for (const btcBasset of btcBassets) {
        // eslint-disable-next-line
        const contract = await deployBasset(deployer, btcBasset.name, btcBasset.symbol, btcBasset.decimals, btcBasset.initialMint)
        bAssets.push({
            contract,
            integrator: btcBasset.integrator,
            txFee: btcBasset.txFee,
            symbol: btcBasset.symbol,
        })
    }

    // 2. Deploy mBTC
    const mBTC = await deployMasset(deployer, addresses, ethers, bAssets)

    // 3. Mint initial supply
    await mint(deployer, bAssets, mBTC)

    // 4. Create savings contract & vault
    const savingsContracts = await deploySave(
        deployer,
        addresses,
        mBTC,
        bAssets.map((b) => b.contract.address),
    )

    // 5. Mint imBTC and deposit to vault
    await depositToVault(deployer, mBTC, savingsContracts)

    // Governance funcs to complete setup:
    //  - Add mBTC savingsContract to SavingsManager to enable interest collection
    //  - Fund the BoostedSavingsVault with MTA to enable rewards
})

task("reDeployMBTC", "Re-deploys the mBTC contracts given bAsset addresses").setAction(async (_, hre) => {
    const { ethers, network } = hre
    const [deployer] = await ethers.getSigners()

    const addresses =
        network.name === "ropsten"
            ? {
                  mta: "0x273bc479E5C21CAA15aA8538DecBF310981d14C0",
                  staking: "0x77f9bf80e0947408f64faa07fd150920e6b52015",
                  nexus: "0xeD04Cd19f50F893792357eA53A549E23Baf3F6cB",
                  proxyAdmin: "0x2d369F83E9DC764a759a74e87a9Bc542a2BbfdF0",
                  rewardsDistributor: "0x99B62B75E3565bEAD786ddBE2642E9c40aA33465",
                  uniswap: DEAD_ADDRESS,
                  poker: DEAD_ADDRESS,
                  renGatewayRegistry: DEAD_ADDRESS,
              }
            : {
                  mta: DEAD_ADDRESS,
                  staking: (await new MockERC20__factory(deployer).deploy("Stake", "ST8", 18, DEAD_ADDRESS, 1)).address,
                  nexus: DEAD_ADDRESS,
                  proxyAdmin: DEAD_ADDRESS,
                  rewardsDistributor: DEAD_ADDRESS,
                  uniswap: DEAD_ADDRESS,
                  poker: DEAD_ADDRESS,
                  renGatewayRegistry: DEAD_ADDRESS,
              }

    const bAssetsRaw: any[] = [
        {
            address: "0xd4Da7c3b1C985b8Baec8D2a5709409CCFE809096",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
        {
            address: "0xf08d8Ab65e709B66e77908cc4EDb530113D8d855",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
        {
            address: "0x82e6459D1B9529cC6A8203f1bFE3B04d6CfCbD43",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
    ]

    // 1. Fetch bAssets
    const erc20Factory = await new ERC20__factory(deployer)
    const bAssets: DeployedBasset[] = await Promise.all(
        bAssetsRaw.map(async (b) => ({
            contract: await erc20Factory.attach(b.address),
            integrator: b.integrator,
            txFee: b.txFee,
            symbol: await (await erc20Factory.attach(b.address)).symbol(),
        })),
    )

    // 2. Deploy mBTC
    const mBTC = await deployMasset(deployer, addresses, ethers, bAssets)

    // 3. Mint initial supply
    await mint(deployer, bAssets, mBTC)

    // 4. Create savings contract & vault
    const savingsContracts = await deploySave(
        deployer,
        addresses,
        mBTC,
        bAssets.map((b) => b.contract.address),
    )

    // 5. Mint imBTC and deposit to vault
    await depositToVault(deployer, mBTC, savingsContracts)

    // Governance funcs to complete setup:
    //  - Add mBTC savingsContract to SavingsManager to enable interest collection
    //  - Fund the BoostedSavingsVault with MTA to enable rewards
})

task("deployMBTC-mainnet", "Deploys the mBTC contracts to Mainnet").setAction(async (_, hre) => {
    const { ethers, network } = hre
    if (network.name !== "mainnet") throw Error("Must be mainnet")

    const [deployer] = await ethers.getSigners()

    const addresses = {
        mta: "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
        staking: "0xae8bc96da4f9a9613c323478be181fdb2aa0e1bf",
        nexus: "0xafce80b19a8ce13dec0739a1aab7a028d6845eb3",
        proxyAdmin: "0x5c8eb57b44c1c6391fc7a8a0cf44d26896f92386",
        rewardsDistributor: "0x04dfdfa471b79cc9e6e8c355e6c71f8ec4916c50",
        uniswap: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        poker: "0x0C2eF8a1b3Bc00Bf676053732F31a67ebbA5bD81",
        renGatewayRegistry: DEAD_ADDRESS,
    }
    const bAssetsRaw: any[] = [
        {
            address: "0xeb4c2781e4eba804ce9a9803c67d0893436bb27d",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
        {
            address: "0xfe18be6b3bd88a2d2a7f928d00292e7a9963cfc6",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
        {
            address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
            integrator: ZERO_ADDRESS,
            txFee: false,
        },
    ]

    // 1. Fetch bAssets
    const erc20Factory = await new ERC20__factory(deployer)
    const bAssets: DeployedBasset[] = await Promise.all(
        bAssetsRaw.map(async (b) => ({
            contract: await erc20Factory.attach(b.address),
            integrator: b.integrator,
            txFee: b.txFee,
            symbol: await (await erc20Factory.attach(b.address)).symbol(),
        })),
    )

    // 2. Deploy mBTC
    const mBTC = await deployMasset(deployer, addresses, ethers, bAssets)

    // 3. Create savings contract
    await deploySave(
        deployer,
        addresses,
        mBTC,
        bAssets.map((b) => b.contract.address),
        false,
    )

    // Governance funcs to complete setup:
    //  - Add mBTC savingsContract to SavingsManager to enable interest collection
})

module.exports = {}
