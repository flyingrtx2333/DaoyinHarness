import {assertExecutionIdentity,type ExecutionIdentity} from "@daoyin/harness-contracts";
import {PROJECT_TOOLS} from "./contracts.js";
export function isProjectAccountIdentity(identity:ExecutionIdentity):boolean{
 assertExecutionIdentity(identity);
 return identity.space.kind==="organization" &&
 /^[1-9][0-9]{0,15}$/u.test(identity.space.tenantId) &&
 identity.space.id==="tenant_"+identity.space.tenantId &&
 new RegExp("^daoyin-projects:"+identity.space.tenantId+":[a-f0-9]{24}$","u").test(identity.appInstallationId) &&
 /^sag_[a-f0-9]{48}$/u.test(identity.authorizationId) &&
 identity.billingAccountId==="harness:"+identity.space.tenantId+":"+identity.actorUserId &&
 identity.permissions.includes("agent.use") && identity.allowedTools.includes("project_list") &&
 identity.allowedTools.every(name=>PROJECT_TOOLS.some(tool=>tool===name));
}
