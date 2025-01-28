import { PlanType } from "../../plans/types.js";
import { createClient } from "@libsql/client/http";
import { isStripeCustomer, stripe } from "../stripe.js";
import Stripe from "stripe";

export const getUserSubscriptionPlan = async (userId: string): Promise<PlanType> => {
    // Function to get user's subscription plan
    try {
        const client = createClient({
            url: process.env.TURSO_DATABASE_URL!,
            authToken: process.env.TURSO_AUTH_TOKEN!,
        });

        const result = await client.execute({
            sql: "SELECT stripeCustomerId FROM user WHERE evoluOwnerId = ?",
            args: [userId],
        });

        const stripeCustomerId = result.rows?.[0]?.stripeCustomerId;
        if (!stripeCustomerId || typeof stripeCustomerId !== 'string') {
            return 'basic';
        }

        try {
            const customerResponse = await stripe.customers.retrieve(stripeCustomerId, {
                expand: ['subscriptions'],
            }) as Stripe.Response<Stripe.Customer>;

            if (!isStripeCustomer(customerResponse)) {
                return 'basic';
            }

            const subscription = customerResponse.subscriptions?.data[0];
            if (!subscription) {
                return 'basic';
            }

            const priceId = subscription.items.data[0]?.price.id;
            if (!priceId) {
                return 'basic';
            }

            const price = await stripe.prices.retrieve(priceId);
            const lookupKey = price.lookup_key;

            if (lookupKey?.includes('pro')) {
                return 'pro';
            }
            else if (lookupKey?.includes('plus')) {
                return 'plus';
            }
            return 'basic';
        } catch (error: unknown) {
            if (error instanceof Error) {
                console.error("Failed to get user subscription plan: ", error.message);
            } else {
                console.error("Failed to get user subscription plan with an unknown error type", error);
            }
            return 'basic';
        }
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error("Failed to get user subscription plan: ", error.message);
        } else {
            console.error("Failed to get user subscription plan with an unknown error type", error);
        }
        return 'basic';
    }
};
