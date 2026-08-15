import { createPublicClient, http, parseAbi, zeroAddress } from "viem"
import { avalancheFuji } from "viem/chains"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import { toPermissionValidator, serializePermissionAccount } from "@zerodev/permissions"
import { toECDSASigner } from "@zerodev/permissions/signers"
import { toCallPolicy, toTimestampPolicy, toRateLimitPolicy, CallPolicyVersion, ParamCondition } from "@zerodev/permissions/policies"
import { createBundlerClient } from "viem/account-abstraction"

const BUNDLER = "https://public.pimlico.io/v2/43113/rpc"
const XSGD = "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E" // mainnet addr, used only for policy encoding here
const entryPoint = getEntryPoint("0.7")
const kernelVersion = KERNEL_V3_1

const publicClient = createPublicClient({ chain: avalancheFuji, transport: http("https://api.avax-test.network/ext/bc/C/rpc") })

const ownerPk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // well-known anvil key #1, throwaway
const owner = privateKeyToAccount(ownerPk)
const sessionKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba")
console.log("owner EOA :", owner.address)
console.log("session key:", sessionKey.address)

const sudoValidator = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion })

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)","function approve(address s,uint256 a) returns (bool)"])

const sessionSigner = await toECDSASigner({ signer: sessionKey })
const permissionValidator = await toPermissionValidator(publicClient, {
  entryPoint, kernelVersion, signer: sessionSigner,
  policies: [
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: [{
        target: XSGD,
        abi: ERC20,
        functionName: "transfer",
        valueLimit: 0n,
        args: [ null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: 600_000000n } ],
      }],
    }),
    toTimestampPolicy({ validAfter: Math.floor(Date.now()/1000), validUntil: Math.floor(Date.now()/1000)+86400 }),
    toRateLimitPolicy({ count: 20, interval: 86400 }),
  ],
})

const account = await createKernelAccount(publicClient, {
  entryPoint, kernelVersion,
  plugins: { sudo: sudoValidator, regular: permissionValidator },
})
console.log("counterfactual smart account:", account.address)
console.log("permissionId:", permissionValidator.getIdentifier?.() ?? "n/a")

const approval = await serializePermissionAccount(account)
console.log("serialized approval length:", approval.length)

// hit the public bundler
const bundler = createBundlerClient({ chain: avalancheFuji, transport: http(BUNDLER) })
console.log("supportedEntryPoints:", await bundler.request({ method: "eth_supportedEntryPoints" }))
try {
  const kc = createKernelAccountClient({ account, chain: avalancheFuji, bundlerTransport: http(BUNDLER), client: publicClient })
  const est = await kc.prepareUserOperation({ calls: [{ to: XSGD, value: 0n, data: "0x" }] })
  console.log("prepared userOp sender:", est.sender)
} catch (e) {
  console.log("prepare/estimate error (expected if unfunded):", String(e).split("\n").slice(0,6).join(" | ").slice(0,600))
}
