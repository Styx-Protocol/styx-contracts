import { ethers, network } from "hardhat";
import { expect } from 'chai';
import { loadFixture } from "ethereum-waffle";
import {
    PERMIT2_ADDRESS,
    PermitTransferFrom,
    SignatureTransfer,
    Witness
} from "@uniswap/permit2-sdk";
import { BigNumber, constants } from "ethers";

const hre = require("hardhat");

const MINIMAL_ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)"
];

const tokenFaucetAddress = "0x60faae176336dab62e284fe19b885b095d29fb7f";
const tokenInAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI
const tokenOutAddress = "0x514910771af9ca656af840dff83e8264ecf986ca"; // LINK
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SIG_DEADLINE = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"

const SWAP_FEE_BPS = "1000"

const amountOutMock = ethers.utils.parseEther("200");

const testAmountIn = ethers.utils.parseEther("100");

describe("Styx Router", function () {
    async function fixtures() {
        const [owner, addr1, addr2] = await ethers.getSigners();

        // Deploy Owner Helper
        const OwnerHelper = await ethers.getContractFactory("OwnerHelperRouter");
        const ownerHelper = await OwnerHelper.deploy();
        await ownerHelper.deployed();

        const ArbAddressTable = await ethers.getContractFactory("ArbAddressTable");
        const arbAddressTable = await ArbAddressTable.deploy();
        await arbAddressTable.deployed();

        // Deploy Permit Proxy
        const StyxRouter = await ethers.getContractFactory("StyxRouter");
        const styxRouter = await StyxRouter.deploy(PERMIT2_ADDRESS, arbAddressTable.address, WETH, ownerHelper.address);
        await styxRouter.deployed();

        // Deploy Utils
        const UtilsRouter = await ethers.getContractFactory("UtilsRouter")
        const utilsRouter = await UtilsRouter.deploy();
        await utilsRouter.deployed();

        await ownerHelper.setAdapter(styxRouter.address, "0x000000000000000000000000000000000000dEaD", "0")
        await ownerHelper.setKeeper(styxRouter.address, addr2.address, true)

        // Get some tokens to swap
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [tokenFaucetAddress],
        });
        const faucet = await ethers.getSigner(tokenFaucetAddress);

        const tokenIn = new ethers.Contract(tokenInAddress, MINIMAL_ERC20_ABI, faucet)
        const tokenInAmount = ethers.utils.parseEther("10000");
        await tokenIn.connect(faucet).transfer(addr1.address, tokenInAmount);

        const tokenOut = new ethers.Contract(tokenOutAddress, MINIMAL_ERC20_ABI, addr1)

        // Give unlimited approval to Permit2
        await tokenIn.connect(addr1).approve(PERMIT2_ADDRESS, constants.MaxInt256)

        return { tokenIn, tokenOut, addr1, styxRouter, utilsRouter, arbAddressTable, addr2 }
    }

    it("Should properly decode the calldata not ETH / amountIn specified", async function () {
        const { tokenIn, tokenOut, arbAddressTable, utilsRouter, styxRouter, addr1, addr2 } = await loadFixture(fixtures);

        const amountInCint = await utilsRouter.compress(testAmountIn);
        // We have to use the uncompressed number for our quote and for the permit
        const amountInUncompressed = await utilsRouter.uncompress(amountInCint);

        // Register token Index from Arb Address Table
        await arbAddressTable.register(tokenIn.address);
        await arbAddressTable.register(tokenOut.address);

        const tokenInIndex = await arbAddressTable.lookup(tokenIn.address)
        const tokenOutIndex = await arbAddressTable.lookup(tokenOut.address)

        const currNonce = await ethers.provider.getStorageAt(styxRouter.address, ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [addr1.address, "0x0"])))

        const permit: PermitTransferFrom = {
            permitted: {
                token: tokenIn.address,
                amount: amountInUncompressed
            },
            spender: styxRouter.address,
            nonce: parseInt(currNonce) + 1337 + 420 + 69,
            deadline: SIG_DEADLINE
        };

        const witness: Witness = {
            witnessTypeName: "Witness",
            witnessType: { Witness: [{ name: "guy", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountOut", type: "uint256" }, { name: "swapFeeBps", type: "uint16" }, { name: "slippageId", type: "uint8" }, { name: "adapterId", type: "uint8" }] },
            witness: { guy: addr1.address, tokenOut: tokenOut.address, amountOut: amountOutMock, swapFeeBps: SWAP_FEE_BPS, slippageId: "0", adapterId: "0" }
        }

        const { chainId } = await ethers.provider.getNetwork();

        const { domain, types, values } = SignatureTransfer.getPermitData(permit, PERMIT2_ADDRESS, chainId, witness);

        const signature = await addr1._signTypedData(domain, types, values);

        const { r, s, v } = ethers.utils.splitSignature(signature);

        const [rCompact, vsCompact] = await utilsRouter.getCompactSignature(v, r, s);

        const data = await utilsRouter.encodeData(0, 0, SWAP_FEE_BPS, amountOutMock, testAmountIn, tokenInIndex, tokenOutIndex, addr1.address, rCompact, vsCompact)

        const rawTx = {
            to: styxRouter.address,
            data: data,
            value: 0,
            gasLimit: 1500000
        }

        hre.tracer.enable = true;

        const signedTx = await addr2.sendTransaction(rawTx);

        hre.tracer.enable = false;

        await new Promise((resolve) => {
            styxRouter.on("Swap", (amountIn, amountOut, tokenIn, tokenOut, guy) => {
                console.log("-".repeat(48))
                console.log("Should properly decode the calldata not ETH / amountIn")
                console.log("-".repeat(48))
                console.log(amountIn)
                console.log(amountOut)
                console.log(tokenIn)
                console.log(tokenOut)
                console.log(guy)
                console.log("-".repeat(48))
                console.log(" ".repeat(48))
                resolve(true);
            });
        })

    })

    it("Should properly decode the calldata not ETH / amountIn is balanceOf", async function () {
        const { tokenIn, tokenOut, arbAddressTable, utilsRouter, styxRouter, addr1, addr2 } = await loadFixture(fixtures);

        // Register token Index from Arb Address Table
        await arbAddressTable.register(tokenIn.address);
        await arbAddressTable.register(tokenOut.address);

        const tokenInIndex = await arbAddressTable.lookup(tokenIn.address)
        const tokenOutIndex = await arbAddressTable.lookup(tokenOut.address)

        const currNonce = await ethers.provider.getStorageAt(styxRouter.address, ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [addr1.address, "0x0"])))

        const permit: PermitTransferFrom = {
            permitted: {
                token: tokenIn.address,
                amount: await tokenIn.balanceOf(addr1.address)
            },
            spender: styxRouter.address,
            nonce: parseInt(currNonce) + 1337 + 420 + 69,
            deadline: SIG_DEADLINE
        };

        const witness: Witness = {
            witnessTypeName: "Witness",
            witnessType: { Witness: [{ name: "guy", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountOut", type: "uint256" }, { name: "swapFeeBps", type: "uint16" }, { name: "slippageId", type: "uint8" }, { name: "adapterId", type: "uint8" }] },
            witness: { guy: addr1.address, tokenOut: tokenOut.address, amountOut: amountOutMock, swapFeeBps: SWAP_FEE_BPS, slippageId: "0", adapterId: "0" }
        }

        const { chainId } = await ethers.provider.getNetwork();

        const { domain, types, values } = SignatureTransfer.getPermitData(permit, PERMIT2_ADDRESS, chainId, witness);

        const signature = await addr1._signTypedData(domain, types, values);

        const { r, s, v } = ethers.utils.splitSignature(signature);

        const [rCompact, vsCompact] = await utilsRouter.getCompactSignature(v, r, s);

        const data = await utilsRouter.encodeData2(0, 0, SWAP_FEE_BPS, amountOutMock, tokenInIndex, tokenOutIndex, addr1.address, rCompact, vsCompact)

        const rawTx = {
            to: styxRouter.address,
            data: data,
            value: 0,
            gasLimit: 1500000
        }

        hre.tracer.enable = true;

        const signedTx = await addr2.sendTransaction(rawTx);

        hre.tracer.enable = false;

        await new Promise((resolve) => {
            styxRouter.on("Swap", (amountIn, amountOut, tokenIn, tokenOut, guy) => {
                console.log("-".repeat(48))
                console.log("Should properly decode the calldata not ETH / amountIn is balanceOf")
                console.log("-".repeat(48))
                console.log(amountIn)
                console.log(amountOut)
                console.log(tokenIn)
                console.log(tokenOut)
                console.log(guy)
                console.log("-".repeat(48))
                console.log(" ".repeat(48))
                resolve(true);
            });
        })

    })

    it("Should properly decode the calldata ETH", async function () {
        const { tokenIn, tokenOut, arbAddressTable, utilsRouter, styxRouter, addr1, addr2 } = await loadFixture(fixtures);

        // Register token Index from Arb Address Table
        await arbAddressTable.register(WETH);
        await arbAddressTable.register(tokenOut.address);

        const tokenInIndex = await arbAddressTable.lookup(WETH)
        const tokenOutIndex = await arbAddressTable.lookup(tokenOut.address)

        const data = await utilsRouter.encodeData3(0, 0, SWAP_FEE_BPS, amountOutMock, tokenInIndex, tokenOutIndex)

        const rawTx = {
            to: styxRouter.address,
            data: data,
            value: ethers.utils.parseEther("1.1337"),
            gasLimit: 1500000
        }

        hre.tracer.enable = true;

        const signedTx = await addr1.sendTransaction(rawTx);

        hre.tracer.enable = false;

        await new Promise((resolve) => {
            styxRouter.on("Swap", (amountIn, amountOut, tokenIn, tokenOut, guy) => {
                console.log("-".repeat(48))
                console.log("Should properly decode the calldata ETH")
                console.log("-".repeat(48))
                console.log(amountIn)
                console.log(amountOut)
                console.log(tokenIn)
                console.log(tokenOut)
                console.log(guy)
                console.log("-".repeat(48))
                console.log(" ".repeat(48))
                resolve(true);
            });
        })

    })

})