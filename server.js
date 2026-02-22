require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const PRICES = {
    truth: { amount: 500, label: 'Truth — 5 Minute Session' },
    dare: { amount: 2500, label: 'Dare — 15 Minute Live Stream' },
};

function platformFee(amount) {
    return Math.round(amount * 0.15);
}

app.post('/create-checkout-session', async (req, res) => {
    const { selectedCard, creatorName, fanName } = req.body;
    if (!selectedCard || !creatorName || !fanName) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    const price = PRICES[selectedCard];
    if (!price) return res.status(400).json({ error: 'Invalid selection.' });
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: price.label,
                        description: `Fan: ${fanName} · Creator: ${creatorName}`,
                    },
                    unit_amount: price.amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}?success=1`,
            cancel_url: `${process.env.FRONTEND_URL}?canceled=1`,
            metadata: { creator: creatorName, fan: fanName, type: selectedCard },
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => res.send('truthordareformyfans.com backend running!'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
