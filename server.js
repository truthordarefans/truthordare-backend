require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tod_secret_change_me';
const BACKEND  = process.env.BACKEND_URL  || 'https://truthordare-backend.onrender.com';
const FRONTEND = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));

const userSchema = new mongoose.Schema({
    name:            { type: String, required: true },
    email:           { type: String, required: true, unique: true, lowercase: true },
    passwordHash:    { type: String, required: true },
    role:            { type: String, enum: ['fan', 'creator'], required: true },
    handle:          { type: String, default: null },
    stripeAccountId: { type: String, default: null },
    createdAt:       { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const featuredSchema = new mongoose.Schema({
    name:      { type: String, required: true },
    email:     { type: String, required: true },
    bio:       { type: String, default: '' },
    platform:  { type: String, default: '' },
    photo:     { type: String, default: null },
    approved:  { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const Featured = mongoose.model('Featured', featuredSchema);

const chatSchema = new mongoose.Schema({
    roomId:    { type: String, required: true },
    name:      { type: String, required: true },
    role:      { type: String, required: true },
    message:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});
const ChatMessage = mongoose.model('ChatMessage', chatSchema);

const bookingSchema = new mongoose.Schema({
    fanName:          { type: String, required: true },
    fanEmail:         { type: String, required: true },
    creatorName:      { type: String, required: true },
    creatorEmail:     { type: String, required: true },
    sessionType:      { type: String, enum: ['truth', 'dare'], required: true },
    requestedDate:    { type: String, required: true },
    requestedTime:    { type: String, required: true },
    proposedDate:     { type: String, default: null },
    proposedTime:     { type: String, default: null },
    status:           { type: String, enum: ['pending', 'accepted', 'declined', 'proposed', 'confirmed', 'expired'], default: 'pending' },
    paymentIntentId:  { type: String, default: null },
    roomId:           { type: String, default: null },
    roomUrl:          { type: String, default: null },
    token:            { type: String, required: true },
    createdAt:        { type: Date, default: Date.now },
});
const Booking = mongoose.model('Booking', bookingSchema);

const PRICES = {
    truth: { amount: 1500, label: 'Truth — 5 Minute Session'    },
    dare:  { amount: 4500, label: 'Dare — 15 Minute Live Stream' },
};
function platformFee(amount) { return Math.round(amount * 0.15); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

async function sendEmail(to, subject, html) {
    if (!process.env.EMAIL_USER) { console.log('Email not configured - skipping'); return; }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, html })
        .catch(e => console.error('Email error:', e.message));
}

async function createDailyRoom(sessionType) {
    if (!process.env.DAILY_API_KEY) return null;
    const expiry = Math.floor(Date.now() / 1000) + (sessionType === 'dare' ? 20 : 10) * 60;
    const response = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` },
        body: JSON.stringify({ properties: { exp: expiry, enable_chat: false, max_participants: 2 } })
    });
    return await response.json();
}

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated.' });
    try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Session expired.' }); }
}

function page(message, color = '#C49050') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Truth or Dare</title>
    <style>body{margin:0;background:#1a0800;color:#f5e6d0;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;box-sizing:border-box;}
    .card{background:#2a1200;border:1px solid ${color};border-radius:12px;padding:32px;max-width:420px;width:100%;text-align:center;}
    h2{color:${color};} a{color:#C49050;}</style></head>
    <body><div class="card"><h2>${message}</h2><p><a href="${FRONTEND}">Back to site</a></p></div></body></html>`;
}

app.post('/register', async (req, res) => {
    const { name, email, password, role, handle } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing required fields.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email, passwordHash, role, handle: handle || null });
        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle } });
    } catch (err) { res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'No account found with this email.' });
        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return res.status(401).json({ error: 'Incorrect password.' });
        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId } });
    } catch (err) { res.status(500).json({ error: 'Login failed.' }); }
});

app.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId });
    } catch (err) { res.status(500).json({ error: 'Could not fetch user.' }); }
});

app.get('/stripe-public-key', (req, res) => {
    res.json({ key: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ── BOOKING REQUEST (fan submits + payment hold) ──────────────────
app.post('/booking-request', async (req, res) => {
    const { fanName, fanEmail, creatorName, creatorEmail, sessionType, requestedDate, requestedTime } = req.body;
    if (!fanName || !fanEmail || !creatorName || !creatorEmail || !sessionType || !requestedDate || !requestedTime)
        return res.status(400).json({ error: 'Missing required fields.' });
    const price = PRICES[sessionType];
    if (!price) return res.status(400).json({ error: 'Invalid session type.' });
    try {
        const token = makeToken();

        // Create Stripe Checkout session with manual capture (hold, not charge)
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'cad', product_data: { name: price.label, description: `${fanName} → ${creatorName} on ${requestedDate} at ${requestedTime}` }, unit_amount: price.amount }, quantity: 1 }],
            mode: 'payment',
            payment_intent_data: { capture_method: 'manual' },
            success_url: `${BACKEND}/booking-paid?token=${token}`,
            cancel_url:  `${FRONTEND}?booking=cancelled`,
            metadata: { fanName, fanEmail, creatorName, creatorEmail, sessionType, requestedDate, requestedTime, token },
        });

        // Save booking with pending status (paymentIntentId filled after payment)
        await Booking.create({
            fanName, fanEmail, creatorName, creatorEmail: creatorEmail.toLowerCase(),
            sessionType, requestedDate, requestedTime,
            paymentIntentId: 'pending_' + token, token,
        });

        res.json({ redirectUrl: session.url });
    } catch (err) {
        console.error('Booking error:', err.message);
        res.status(500).json({ error: err.message || 'Booking failed.' });
    }
});

// ── AFTER STRIPE PAYMENT — update paymentIntentId and notify creator ──
app.get('/booking-paid', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send(page('Invalid link.', '#8b2020'));
    try {
        const booking = await Booking.findOne({ token });
        if (!booking) return res.status(404).send(page('Booking not found.', '#8b2020'));

        // Find real paymentIntentId from Stripe checkout session
        if (booking.paymentIntentId.startsWith('pending_')) {
            const sessions = await stripe.checkout.sessions.list({ limit: 10 });
            const match = sessions.data.find(s => s.metadata?.token === token);
            if (match?.payment_intent) {
                booking.paymentIntentId = match.payment_intent;
                await booking.save();
            }
        }

        const price = PRICES[booking.sessionType];
        await sendEmail(booking.creatorEmail, `🎯 New Session Request from ${booking.fanName}`,
            `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;">
            <h2 style="color:#C49050;">New Challenge Request!</h2>
            <p><strong>Fan:</strong> ${booking.fanName}</p>
            <p><strong>Session:</strong> ${price.label}</p>
            <p><strong>Requested Date:</strong> ${booking.requestedDate}</p>
            <p><strong>Requested Time:</strong> ${booking.requestedTime}</p>
            <p style="color:#aaa;font-size:13px;">Payment of $${(price.amount/100).toFixed(2)} CAD is held — only charged if you accept.</p>
            <div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;">
                <a href="${BACKEND}/booking-respond?token=${token}&action=accept" style="background:#2d7a2d;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">✅ Accept</a>
                <a href="${BACKEND}/booking-respond?token=${token}&action=decline" style="background:#8b2020;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">❌ Decline</a>
                <a href="${BACKEND}/booking-propose?token=${token}" style="background:#C49050;color:#1a0800;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">🕐 Propose Different Time</a>
            </div></div>`
        );
        await sendEmail(booking.fanEmail, `⏳ Request Sent to ${booking.creatorName}`,
            `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;">
            <h2 style="color:#C49050;">Request Sent!</h2>
            <p>Your session request has been sent to <strong>${booking.creatorName}</strong>.</p>
            <p><strong>Session:</strong> ${price.label}</p>
            <p><strong>Requested:</strong> ${booking.requestedDate} at ${booking.requestedTime}</p>
            <p style="color:#aaa;font-size:13px;">Your card has a temporary hold of $${(price.amount/100).toFixed(2)} CAD. You will only be charged if the creator accepts.</p>
            </div>`
        );

        return res.send(page(`✅ Request sent to ${booking.creatorName}! You'll get an email once they respond.`, '#2d7a2d'));
    } catch (err) { res.status(500).send(page('Error: ' + err.message, '#8b2020')); }
});


// ── CREATOR RESPONDS (Accept / Decline) ──────────────────────────
app.get('/booking-respond', async (req, res) => {
    const { token, action } = req.query;
    if (!token || !['accept','decline'].includes(action)) return res.status(400).send(page('Invalid link.', '#8b2020'));
    try {
        const booking = await Booking.findOne({ token });
        if (!booking) return res.status(404).send(page('Booking not found.', '#8b2020'));
        if (booking.status !== 'pending') return res.send(page(`This request has already been ${booking.status}.`, '#C49050'));

        if (action === 'accept') {
            await stripe.paymentIntents.capture(booking.paymentIntentId);
            let roomUrl = null;
            try { const room = await createDailyRoom(booking.sessionType); if (room?.url) { roomUrl = room.url; booking.roomId = room.name; booking.roomUrl = room.url; } } catch(e) {}
            booking.status = 'accepted';
            await booking.save();
            const dateStr = `${booking.requestedDate} at ${booking.requestedTime}`;
            const roomHtml = roomUrl ? `<p><strong>Session Room:</strong> <a href="${roomUrl}" style="color:#C49050;">${roomUrl}</a></p>` : '';
            await sendEmail(booking.creatorEmail, `✅ Session Confirmed — ${booking.fanName}`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#2d7a2d;">Session Confirmed!</h2><p><strong>Fan:</strong> ${booking.fanName}</p><p><strong>Session:</strong> ${PRICES[booking.sessionType].label}</p><p><strong>Date & Time:</strong> ${dateStr}</p>${roomHtml}</div>`);
            await sendEmail(booking.fanEmail, `✅ ${booking.creatorName} Accepted Your Request!`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#2d7a2d;">Session Confirmed!</h2><p><strong>Creator:</strong> ${booking.creatorName}</p><p><strong>Session:</strong> ${PRICES[booking.sessionType].label}</p><p><strong>Date & Time:</strong> ${dateStr}</p>${roomHtml}<p style="color:#aaa;font-size:13px;">Your card has been charged $${(PRICES[booking.sessionType].amount/100).toFixed(2)} CAD.</p></div>`);
            return res.send(page(`✅ Accepted! ${booking.fanName} has been notified and the session room link sent to both of you.`, '#2d7a2d'));
        } else {
            await stripe.paymentIntents.cancel(booking.paymentIntentId);
            booking.status = 'declined';
            await booking.save();
            await sendEmail(booking.fanEmail, `❌ Session Declined by ${booking.creatorName}`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#8b2020;">Request Declined</h2><p>${booking.creatorName} was unable to accept your request for ${booking.requestedDate} at ${booking.requestedTime}.</p><p style="color:#aaa;font-size:13px;">Your payment hold has been fully released — no charge was made.</p><p><a href="${FRONTEND}" style="color:#C49050;">Book with another creator →</a></p></div>`);
            return res.send(page(`❌ Declined. ${booking.fanName}'s payment hold has been released.`, '#8b2020'));
        }
    } catch (err) { res.status(500).send(page('Error: ' + err.message, '#8b2020')); }
});

// ── PROPOSE DIFFERENT TIME (form) ─────────────────────────────────
app.get('/booking-propose', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send(page('Invalid link.', '#8b2020'));
    const booking = await Booking.findOne({ token });
    if (!booking) return res.status(404).send(page('Booking not found.', '#8b2020'));
    if (booking.status !== 'pending') return res.send(page(`Already ${booking.status}.`, '#C49050'));
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Propose New Time</title>
    <style>body{margin:0;background:#1a0800;color:#f5e6d0;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;box-sizing:border-box;}
    .card{background:#2a1200;border:1px solid #C49050;border-radius:12px;padding:32px;max-width:420px;width:100%;}
    h2{color:#C49050;margin-top:0;} label{display:block;margin-bottom:6px;font-size:14px;color:#aaa;}
    input{width:100%;padding:10px 12px;background:#1a0800;border:1px solid #C49050;border-radius:6px;color:#f5e6d0;font-size:15px;box-sizing:border-box;margin-bottom:16px;}
    button{width:100%;padding:14px;background:#C49050;color:#1a0800;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;}
    .info{background:#1a0800;border-radius:8px;padding:12px;margin-bottom:20px;font-size:14px;}</style></head>
    <body><div class="card"><h2>🕐 Propose a New Time</h2>
    <div class="info"><strong>Fan:</strong> ${booking.fanName}<br><strong>Session:</strong> ${PRICES[booking.sessionType].label}<br><strong>Original:</strong> ${booking.requestedDate} at ${booking.requestedTime}</div>
    <form action="${BACKEND}/booking-propose" method="POST">
    <input type="hidden" name="token" value="${token}">
    <label>New Date</label><input type="date" name="proposedDate" required>
    <label>New Time</label><input type="time" name="proposedTime" required>
    <button type="submit">Send Proposed Time →</button></form></div></body></html>`);
});

app.post('/booking-propose', express.urlencoded({ extended: true }), async (req, res) => {
    const { token, proposedDate, proposedTime } = req.body;
    if (!token || !proposedDate || !proposedTime) return res.status(400).send(page('Missing fields.', '#8b2020'));
    try {
        const booking = await Booking.findOne({ token });
        if (!booking) return res.status(404).send(page('Booking not found.', '#8b2020'));
        if (booking.status !== 'pending') return res.send(page(`Already ${booking.status}.`, '#C49050'));
        const [h, m] = proposedTime.split(':');
        const hr = parseInt(h);
        const displayTime = `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
        booking.status = 'proposed'; booking.proposedDate = proposedDate; booking.proposedTime = displayTime;
        await booking.save();
        await sendEmail(booking.fanEmail, `🕐 ${booking.creatorName} Proposed a New Time`,
            `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;">
            <h2 style="color:#C49050;">${booking.creatorName} Proposed a New Time</h2>
            <p><strong>Session:</strong> ${PRICES[booking.sessionType].label}</p>
            <p><strong>Original request:</strong> ${booking.requestedDate} at ${booking.requestedTime}</p>
            <p><strong>New proposed time:</strong> ${proposedDate} at ${displayTime}</p>
            <p style="color:#aaa;font-size:13px;">Your payment hold is still active. Only charged if you accept.</p>
            <div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;">
                <a href="${BACKEND}/booking-confirm?token=${token}&action=accept" style="background:#2d7a2d;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">✅ Accept New Time</a>
                <a href="${BACKEND}/booking-confirm?token=${token}&action=decline" style="background:#8b2020;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">❌ Cancel & Refund</a>
            </div></div>`);
        return res.send(page(`✅ New time sent to ${booking.fanName}!`, '#2d7a2d'));
    } catch (err) { res.status(500).send(page('Error: ' + err.message, '#8b2020')); }
});

// ── FAN CONFIRMS PROPOSED TIME ────────────────────────────────────
app.get('/booking-confirm', async (req, res) => {
    const { token, action } = req.query;
    if (!token || !['accept','decline'].includes(action)) return res.status(400).send(page('Invalid link.', '#8b2020'));
    try {
        const booking = await Booking.findOne({ token });
        if (!booking) return res.status(404).send(page('Booking not found.', '#8b2020'));
        if (booking.status !== 'proposed') return res.send(page(`Already ${booking.status}.`, '#C49050'));
        if (action === 'accept') {
            await stripe.paymentIntents.capture(booking.paymentIntentId);
            let roomUrl = null;
            try { const room = await createDailyRoom(booking.sessionType); if (room?.url) { roomUrl = room.url; booking.roomId = room.name; booking.roomUrl = room.url; } } catch(e) {}
            booking.status = 'confirmed';
            await booking.save();
            const dateStr = `${booking.proposedDate} at ${booking.proposedTime}`;
            const roomHtml = roomUrl ? `<p><strong>Session Room:</strong> <a href="${roomUrl}" style="color:#C49050;">${roomUrl}</a></p>` : '';
            await sendEmail(booking.creatorEmail, `✅ Fan Confirmed — ${booking.fanName}`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#2d7a2d;">Session Confirmed!</h2><p><strong>Fan:</strong> ${booking.fanName}</p><p><strong>Date & Time:</strong> ${dateStr}</p>${roomHtml}</div>`);
            await sendEmail(booking.fanEmail, `✅ Session Confirmed with ${booking.creatorName}!`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#2d7a2d;">Session Confirmed!</h2><p><strong>Creator:</strong> ${booking.creatorName}</p><p><strong>Date & Time:</strong> ${dateStr}</p>${roomHtml}<p style="color:#aaa;font-size:13px;">Charged $${(PRICES[booking.sessionType].amount/100).toFixed(2)} CAD.</p></div>`);
            return res.send(page(`✅ Confirmed for ${dateStr}! Room link sent to both of you.`, '#2d7a2d'));
        } else {
            await stripe.paymentIntents.cancel(booking.paymentIntentId);
            booking.status = 'declined'; await booking.save();
            await sendEmail(booking.creatorEmail, `❌ Fan Declined New Time — ${booking.fanName}`,
                `<div style="font-family:sans-serif;max-width:500px;margin:auto;background:#1a0800;color:#f5e6d0;padding:30px;border-radius:12px;"><h2 style="color:#8b2020;">Fan Declined</h2><p>${booking.fanName} declined the proposed time. No payment taken.</p></div>`);
            return res.send(page('Booking cancelled. Your payment hold has been fully released.', '#C49050'));
        }
    } catch (err) { res.status(500).send(page('Error: ' + err.message, '#8b2020')); }
});

// ── LEGACY CHECKOUT ───────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
    const { selectedCard, creatorName, fanName, creatorStripeAccountId } = req.body;
    if (!selectedCard || !creatorName || !fanName) return res.status(400).json({ error: 'Missing fields.' });
    const price = PRICES[selectedCard];
    if (!price) return res.status(400).json({ error: 'Invalid card.' });
    try {
        const sessionParams = {
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'cad', product_data: { name: price.label, description: `Fan: ${fanName} · Creator: ${creatorName}` }, unit_amount: price.amount }, quantity: 1 }],
            mode: 'payment', success_url: `${FRONTEND}?success=1`, cancel_url: `${FRONTEND}?canceled=1`,
            metadata: { creator: creatorName, fan: fanName, type: selectedCard },
        };
        if (creatorStripeAccountId) sessionParams.payment_intent_data = { application_fee_amount: platformFee(price.amount), transfer_data: { destination: creatorStripeAccountId } };
        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/onboard-creator', async (req, res) => {
    const { creatorEmail, creatorName } = req.body;
    try {
        const account = await stripe.accounts.create({ type: 'express', email: creatorEmail, capabilities: { transfers: { requested: true } }, business_profile: { name: creatorName, url: FRONTEND } });
        const accountLink = await stripe.accountLinks.create({ account: account.id, refresh_url: `${FRONTEND}/onboard-refresh?account=${account.id}`, return_url: `${FRONTEND}/onboard-complete.html?account=${account.id}`, type: 'account_onboarding' });
        await User.findOneAndUpdate({ email: creatorEmail.toLowerCase() }, { stripeAccountId: account.id });
        res.json({ accountId: account.id, onboardingUrl: accountLink.url });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        console.log('Payment:', { creator: s.metadata.creator, fan: s.metadata.fan, total: `$${(s.amount_total/100).toFixed(2)}` });
    }
    res.json({ received: true });
});

app.post('/featured-apply', async (req, res) => {
    const { name, email, bio, platform, photo } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    try {
        const existing = await Featured.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'Application already exists.' });
        await Featured.create({ name, email: email.toLowerCase(), bio: bio||'', platform: platform||'', photo: photo||null });
        if (process.env.ADMIN_EMAIL) await sendEmail(process.env.ADMIN_EMAIL, `⭐ New Creator Application: ${name}`, `<h2>New Application</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Bio:</strong> ${bio||'N/A'}</p>`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Submission failed.' }); }
});

app.get('/featured-creators', async (req, res) => {
    try { const creators = await Featured.find({ approved: true }, { email: 0 }).sort({ createdAt: -1 }); res.json({ creators }); }
    catch (err) { res.status(500).json({ error: 'Could not fetch.' }); }
});

app.post('/featured-approve', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    try { await Featured.findByIdAndUpdate(req.body.id, { approved: req.body.approved }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: 'Could not update.' }); }
});

app.post('/create-room', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try { const room = await createDailyRoom(req.body.sessionType); res.json({ roomId: room.name, url: room.url }); }
    catch (err) { res.status(500).json({ error: 'Could not create room.' }); }
});

app.get('/get-room/:roomId', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const r = await fetch(`https://api.daily.co/v1/rooms/${req.params.roomId}`, { headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` } });
        res.json({ url: (await r.json()).url });
    } catch (err) { res.status(500).json({ error: 'Could not fetch room.' }); }
});

app.post('/room-chat/:roomId', requireAuth, async (req, res) => {
    if (!req.body.message) return res.status(400).json({ error: 'Message required.' });
    try { await ChatMessage.create({ roomId: req.params.roomId, name: req.body.name, role: req.body.role, message: req.body.message }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: 'Could not save.' }); }
});

app.get('/room-chat/:roomId', async (req, res) => {
    const since = parseInt(req.query.since) || 0;
    try { const messages = await ChatMessage.find({ roomId: req.params.roomId }).sort({ createdAt: 1 }); res.json({ messages: messages.slice(since) }); }
    catch (err) { res.status(500).json({ error: 'Could not fetch.' }); }
});

app.get('/', (req, res) => res.send('truthordareformyfans.com backend ✓'));

app.listen(PORT, () => {
    console.log(`\n🎯 Server running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
    console.log(`   Split: 85% creator / 15% platform\n`);
});
