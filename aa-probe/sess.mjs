import { getSmartSessionsValidator, getPermissionId, getSpendingLimitsPolicy, getTimeFramePolicy, getUsageLimitPolicy, getUniversalActionPolicy, getSudoPolicy, encodeSmartSessionSignature, SmartSessionMode, getEnableSessionsAction } from "@rhinestone/module-sdk"
import { GLOBAL_CONSTANTS } from "@rhinestone/module-sdk"
import { toHex, parseAbi, toFunctionSelector } from "viem"
const XSGD = "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E"
const AGENT = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
const OWNABLE_VALIDATOR = "0x000000000013fdB5234E4E3162a810F54d9f7E98"
const now = Math.floor(Date.now()/1000)
const session = {
  sessionValidator: OWNABLE_VALIDATOR,
  sessionValidatorInitData: "0x0000000000000000000000000000000000000000000000000000000000000001" + AGENT.slice(2).toLowerCase().padStart(64,"0"),
  salt: toHex(1, { size: 32 }),
  userOpPolicies: [
    getTimeFramePolicy({ validAfter: now, validUntil: now + 30*86400 }),
    getUsageLimitPolicy({ limit: 50n }),
  ],
  erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
  actions: [{
    actionTarget: XSGD,
    actionTargetSelector: toFunctionSelector("transfer(address,uint256)"),
    actionPolicies: [ getSpendingLimitsPolicy([{ token: XSGD, limit: 5000_000000n }]) ],
  }],
  permitERC4337Paymaster: true,
  chainId: 43113n,
}
console.log("SMART_SESSIONS_ADDRESS       :", GLOBAL_CONSTANTS.SMART_SESSIONS_ADDRESS)
console.log("SPENDING_LIMITS_POLICY_ADDRESS:", GLOBAL_CONSTANTS.SPENDING_LIMITS_POLICY_ADDRESS)
console.log("permissionId                  :", getPermissionId({ session }))
const v = getSmartSessionsValidator({ sessions: [session] })
console.log("validator module              :", v.address ?? v.module, "initData len", (v.initData||"").length)
const act = getEnableSessionsAction({ sessions: [session] })
console.log("enableSessions action target  :", act.target ?? act.to, "calldata len", (act.callData||act.data||"").length)
