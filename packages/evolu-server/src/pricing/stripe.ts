import Stripe from "stripe";

// Initialize Stripe
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2024-12-18.acacia",
    typescript: true,
});

// Type guard for Stripe Customer
export const isStripeCustomer = (customer: unknown): customer is Stripe.Customer => {
    return typeof customer === 'object' && customer !== null && !('deleted' in customer);
};