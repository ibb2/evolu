import { Kysely } from "kysely";
import { PLAN_LIMITS } from "../plans/index.js";
import { getUserDataSize, getUserSubscriptionPlan } from "../index.js";


export const canUserSync = async (db: Kysely<any>, userId: string): Promise<boolean> => {
    // Function to check if user can sync based on their plan and database size
    try {
        const [plan, dbSize] = await Promise.all([
            getUserSubscriptionPlan(userId),
            getUserDataSize(db, userId),
        ]);
        const sizeLimit = PLAN_LIMITS[plan];
        const canSync = dbSize < sizeLimit;
        console.log(`User ${userId} sync check: plan=${plan}, size=${dbSize.toFixed(2)}GB, limit=${sizeLimit}GB, canSync=${canSync}`);
        return canSync;
    }
    catch (err) {
        console.error("Error checking sync eligibility:", err instanceof Error ? err.message : String(err));
        throw err;
    }
};