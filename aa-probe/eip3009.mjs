import { createPublicClient, http, encodeFunctionData, parseAbi, hexToBigInt } from "viem"
import { avalanche } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
const XSGD = "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E"
const pc = createPublicClient({ chain: avalanche, transport: http("https://api.avax.network/ext/bc/C/rpc") })
const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const domain = { name: "XSGD", version: "2", chainId: 43114, verifyingContract: XSGD }
const types = { TransferWithAuthorization: [
  {name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
  {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}] }
const msg = { from: acct.address, to: "0x000000000000000000000000000000000000dEaD", value: 1000000n,
  validAfter: 0n, validBefore: BigInt(Math.floor(Date.now()/1000)+3600),
  nonce: "0x1111111111111111111111111111111111111111111111111111111111111111" }
const sig = await acct.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message: msg })
const r = sig.slice(0,66), s = "0x"+sig.slice(66,130), v = parseInt(sig.slice(130,132),16)
const abi = parseAbi(["function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"])
const data = encodeFunctionData({ abi, functionName: "transferWithAuthorization",
  args: [msg.from,msg.to,msg.value,msg.validAfter,msg.validBefore,msg.nonce,v,r,s] })
try {
  await pc.call({ to: XSGD, data, account: "0x0000000000000000000000000000000000000009" })
  console.log("eth_call SUCCEEDED (unexpected)")
} catch (e) {
  const m = (e.shortMessage||"")+" | "+(e.details||"")+" | "+(e.metaMessages||[]).join(" ")
  console.log("revert reason:", m.slice(0,400))
}
