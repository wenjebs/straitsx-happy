import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem"
import { avalancheFuji } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import { toPermissionValidator } from "@zerodev/permissions"
import { toECDSASigner } from "@zerodev/permissions/signers"
import { toCallPolicy, CallPolicyVersion, ParamCondition } from "@zerodev/permissions/policies"
import { createPimlicoClient } from "permissionless/clients/pimlico"

const BUNDLER = "https://public.pimlico.io/v2/43113/rpc"
const XSGD = "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E"
const entryPoint = getEntryPoint("0.7"); const kernelVersion = KERNEL_V3_1
const publicClient = createPublicClient({ chain: avalancheFuji, transport: http("https://api.avax-test.network/ext/bc/C/rpc") })
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const sessionKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba")
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"])
const sudo = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion })
const perm = await toPermissionValidator(publicClient, { entryPoint, kernelVersion, signer: await toECDSASigner({ signer: sessionKey }),
  policies: [toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [{ target: XSGD, abi: ERC20, functionName: "transfer", valueLimit: 0n,
    args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: 600_000000n }] }] })] })
const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo, regular: perm } })
console.log("smart account:", account.address)
const pimlico = createPimlicoClient({ transport: http(BUNDLER), entryPoint })
const kc = createKernelAccountClient({ account, chain: avalancheFuji, bundlerTransport: http(BUNDLER), client: publicClient,
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } })
const call = { to: XSGD, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 500_000000n] }) }
try {
  const uo = await kc.prepareUserOperation({ calls: [call] })
  console.log("PREPARED userOp OK. sender", uo.sender, "callGasLimit", uo.callGasLimit, "vgl", uo.verificationGasLimit, "pvg", uo.preVerificationGas, "factory", uo.factory)
} catch (e) { console.log("ESTIMATE ERROR:", String(e.shortMessage||e).slice(0,400)); console.log((e.details||"").slice(0,300)) }
