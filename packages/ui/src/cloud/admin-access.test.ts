import {describe,expect,it} from "vitest";
import {canShowAdmin,requestedAdminView} from "./admin-access.js";
describe("administrator navigation",()=>{
 it("requires a server-issued scope",()=>{expect(canShowAdmin("a".repeat(64))).toBe(true);expect(canShowAdmin("")).toBe(false);expect(canShowAdmin("administrator")).toBe(false);});
 it("rejects a forged admin hash",()=>{expect(requestedAdminView("#admin",false)).toBe(false);expect(requestedAdminView("#admin",true)).toBe(true);expect(requestedAdminView("#plugins",true)).toBe(false);});
});
