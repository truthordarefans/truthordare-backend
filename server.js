require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Resend } = require('resend');
const webpush = require('web-push');

// VAPID keys for web push notifications (optional — push notifications disabled if not set)
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails('mailto:truthordarefans@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
    console.warn('VAPID keys not set — push notifications disabled');
}
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY) { console.warn('RESEND_API_KEY not set — skipping email'); return; }
    try {
        const { error } = await resend.emails.send({
            from: 'Truth or Dare For My Fans <noreply@truthordareformyfans.com>',
            to,
            subject,
            html,
        });
        if (error) { console.error('Resend error:', error); } else { console.log(`📧 Email sent to ${to}: ${subject}`); }
    } catch (err) { console.error('Email send error:', err.message); }
}

// Branded HTML email template builder
function emailTemplate({ title, preheader = '', bodyHtml, ctaUrl = null, ctaText = null, footerNote = '' }) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#1a0000;font-family:'Helvetica Neue',Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1a0000;padding:32px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0d0000;border:1px solid rgba(212,165,116,0.35);border-radius:14px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#8B0000 0%,#5c0000 100%);padding:24px 32px;text-align:center;border-bottom:2px solid rgba(212,165,116,0.4);">
  <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2px;color:#D4A574;text-transform:uppercase;font-weight:700;">Truth or Dare For My Fans</p>
  <h1 style="margin:0;font-size:22px;color:#FDF6EC;font-weight:800;line-height:1.3;">${title}</h1>
</td></tr>
<tr><td style="padding:28px 32px;">
  ${bodyHtml}
  ${ctaUrl && ctaText ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0 0;"><tr><td align="center"><a href="${ctaUrl}" style="display:inline-block;background:#D4A574;color:#120500;padding:15px 36px;border-radius:8px;font-weight:800;font-size:15px;text-decoration:none;letter-spacing:0.5px;">${ctaText}</a></td></tr></table>` : ''}
</td></tr>
<tr><td style="background:rgba(0,0,0,0.3);padding:16px 32px;border-top:1px solid rgba(212,165,116,0.15);text-align:center;">
  ${footerNote ? `<p style="margin:0 0 8px 0;font-size:12px;color:#9A8A72;">${footerNote}</p>` : ''}
  <p style="margin:0;font-size:11px;color:#6B5A4A;">© 2026 <a href="${frontendUrl}" style="color:#D4A574;text-decoration:none;">truthordareformyfans.com</a> &nbsp;·&nbsp; <a href="${frontendUrl}/terms.html" style="color:#9A8A72;text-decoration:none;">Terms</a> &nbsp;·&nbsp; <a href="${frontendUrl}/privacy.html" style="color:#9A8A72;text-decoration:none;">Privacy</a></p>
</td></tr></table></td></tr></table></body></html>`;
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tod_jwt_fallback_change_in_render';
const BACKEND = process.env.BACKEND_URL || 'https://truthordare-backend.onrender.com';
const FRONTEND = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

app.use(cors({
    origin: [
        'https://www.truthordareformyfans.com',
        'https://truthordareformyfans.com',
        'https://truthordare-backend.onrender.com'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'],
    credentials: true
}));

// CRITICAL: Stripe webhook requires raw body for signature verification.
// Must be registered BEFORE express.json() middleware.
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') {
        let rawData = Buffer.alloc(0);
        req.on('data', chunk => { rawData = Buffer.concat([rawData, chunk]); });
        req.on('end', () => { req.rawBody = rawData; next(); });
    } else {
        next();
    }
});

app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// Schemas
const userSchema = new mongoose.Schema({
    name:        { type: String, required: true },       // Display / stage name (public)
    legalName:   { type: String, default: null },        // Legal name (private, for Stripe)
    email:       { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role:        { type: String, enum: ['fan', 'creator'], required: true },
    handle:      { type: String, default: null },
    bio:         { type: String, default: '' },
    photo:       { type: String, default: null },
    isLive:      { type: Boolean, default: false },
    inSession:   { type: Boolean, default: false },
    featuredRequested: { type: Boolean, default: false },
    stripeAccountId: { type: String, default: null },
    socials: {
        instagram:  { type: String, default: null },
        onlyfans:   { type: String, default: null },
        fansly:     { type: String, default: null },
        fansvue:    { type: String, default: null },
        luvelyfans: { type: String, default: null },
        tiktok:     { type: String, default: null },
    },
    extraPhotos: { type: [String], default: [] },
    notificationPrefs: {
        email:       { type: Boolean, default: true },
        sms:         { type: Boolean, default: false },
        phone:       { type: String, default: null },   // phone number for SMS
        customHandle: { type: String, default: null },  // e.g. "DM me on Instagram @zara"
    },
    createdAt:   { type: Date, default: Date.now },
    resetToken:  { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
    lastHeartbeat: { type: Date, default: null },   // for auto-offline detection
    pushSubscription: { type: mongoose.Schema.Types.Mixed, default: null }, // web push subscription object
});
const User = mongoose.model('User', userSchema);

const featuredSchema = new mongoose.Schema({
    name:        { type: String, required: true },
    email:       { type: String, required: true },
    bio:         { type: String, default: '' },
    platform:    { type: String, default: '' },
    photo:       { type: String, default: null },
    approved:    { type: Boolean, default: false },
    createdAt:   { type: Date, default: Date.now },
});
const Featured = mongoose.model('Featured', featuredSchema);

const chatSchema = new mongoose.Schema({
    roomId:      { type: String, required: true },
    name:        { type: String, required: true },
    role:        { type: String, required: true },
    createdAt:   { type: Date, default: Date.now },
});
const ChatMessage = mongoose.model('ChatMessage', chatSchema);

const bookingSchema = new mongoose.Schema({
    fanName:     { type: String, required: true },
    fanEmail:    { type: String, required: true },
    creatorName: { type: String, required: true },
    creatorEmail: { type: String, required: true },
    sessionType: { type: String, enum: ['truth', 'dare'], required: true },
    requestedDate: { type: String, required: true },
    proposedDate: { type: String, default: null },
    proposedTime: { type: String, default: null },
    counterProposals: { type: Array, default: [] }, // [{date, time}, {date, time}, {date, time}]
    fanChosenDate: { type: String, default: null },
    fanChosenTime: { type: String, default: null },
    status:      { type: String, enum: ['pending', 'accepted', 'declined', 'proposed', 'confirmed', 'expired', 'refused', 'paid'], default: 'pending' },
    requestedTime: { type: String, default: null },
    note:        { type: String, default: null },
    paymentIntentId: { type: String, default: null },
    roomId:      { type: String, default: null },
    roomUrl:     { type: String, default: null },
    token:       { type: String, default: null },
    sessionPin:  { type: String, default: null },   // 4-digit PIN for room entry
    stripeCustomerId: { type: String, default: null }, // Saved card customer ID
    extensionPending: { type: String, default: null }, // 'truth' or 'dare' if fan requested extension
    extensionStatus: { type: String, default: null }, // 'requested', 'accepted', 'declined', 'extended'
    extensionType: { type: String, default: null }, // 'truth' or 'dare' for the extension
    fanInRoom:   { type: Boolean, default: false }, // true when fan has entered the session room
    createdAt:   { type: Date, default: Date.now },
});
const Booking = mongoose.model('Booking', bookingSchema);

// Middleware for authentication
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) { return res.status(403).json({ error: 'Invalid token.' }); }
};

// Helper to calculate platform fee
const platformFee = (amount) => Math.round(amount * 0.15); // 15% platform fee

// Daily.co API for video rooms
const createDailyRoom = async (sessionType) => {
    const roomDuration = sessionType === 'truth' ? 5 : 15; // 5 min for truth, 15 min for dare
    const roomExpiry = Math.round(Date.now() / 1000) + (24 * 60 * 60); // Room available for 24 hours
    const response = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DAILY_API_KEY}`,
        },
        body: JSON.stringify({
            properties: {
                max_participants: 2,
                enable_prejoin_ui: false,
                enable_knocking: false,
                enable_chat: true,
                start_video_off: true,
                start_audio_off: false,
                exp: roomExpiry, // Room available for 24 hours from creation
                eject_at_token_exp: false,
            },
        }),
    });
    if (!response.ok) throw new Error(`Daily.co API error: ${response.statusText}`);
    return response.json();
};

// Routes
// Handle availability check
app.get('/check-handle/:handle', async (req, res) => {
    try {
        const raw = req.params.handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!raw || raw.length < 3) return res.json({ available: false, reason: 'Handle must be at least 3 characters.' });
        if (raw.length > 20) return res.json({ available: false, reason: 'Handle must be 20 characters or less.' });
        const fullHandle = `${raw}@truthordare`;
        const existing = await User.findOne({ handle: fullHandle });
        if (existing) return res.json({ available: false, reason: 'That handle is already taken.' });
        return res.json({ available: true, handle: fullHandle });
    } catch (err) { res.status(500).json({ available: false, reason: 'Server error.' }); }
});

app.post('/register', async (req, res) => {
    const { name, legalName, email, password, role, handle, socials, notificationPrefs } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required.' });
    try {
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) return res.status(409).json({ error: 'User already exists.' });
        const passwordHash = await bcrypt.hash(password, 10);
        // Format handle as name@truthordare (strip any leading @ or existing @truthordare suffix)
        let handleFormatted = null;
        if (handle) {
            let h = handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            handleFormatted = h ? `${h}@truthordare` : null;
        }
        // Build notification prefs (default to email if not provided)
        const notifPrefs = {
            email: notificationPrefs?.email !== false,
            sms: !!notificationPrefs?.sms,
            phone: notificationPrefs?.phone || null,
            customHandle: notificationPrefs?.customHandle || null,
        };
        const user = await User.create({ name, legalName: legalName || null, email: email.toLowerCase(), passwordHash, role, handle: handleFormatted, socials: socials || {}, notificationPrefs: notifPrefs });
        
        // Notify admin
        const adminEmail = 'Truthordarefans@gmail.com';
        const adminHtml = emailTemplate({
            title: `New ${role === 'creator' ? 'Creator' : 'Fan'} Registered`,
            preheader: `New user registration: ${name}`,
            bodyHtml: `<p style="color:#FDF6EC;">A new ${role} just registered!</p><ul><li style="color:#C9B99A;">Name: ${name}</li><li style="color:#C9B99A;">Email: ${email}</li>${handleFormatted ? `<li style="color:#C9B99A;">Handle: ${handleFormatted}</li>` : ''}</ul>`,
        });
        sendEmail(adminEmail, `🚨 New ${role} registered: ${name}`, adminHtml).catch(e => console.error(e));

        const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET);
        res.status(201).json({ message: 'User registered.', token, role: user.role, handle: user.handle });
    } catch (err) { res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
        const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET);
        res.json({ message: 'Logged in.', token, role: user.role, handle: user.handle });
    } catch (err) { res.status(500).json({ error: 'Login failed.' }); }
});

// Temporary admin password reset — secured by secret key
app.post('/admin-reset-password', async (req, res) => {
    const { secret, email, newPassword } = req.body;
    if (secret !== 'TOD_ADMIN_2026') return res.status(403).json({ error: 'Forbidden.' });
    if (!email || !newPassword) return res.status(400).json({ error: 'Email and newPassword required.' });
    try {
        const passwordHash = await bcrypt.hash(newPassword, 10);
        const user = await User.findOneAndUpdate(
            { email: email.toLowerCase() },
            { passwordHash },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ success: true, message: `Password reset for ${email}` });
    } catch (err) { res.status(500).json({ error: 'Reset failed.' }); }
});

// Temporary admin delete user route
app.post('/admin-delete-user', async (req, res) => {
    const { secret, email } = req.body;
    if (secret !== 'TOD_ADMIN_2026') return res.status(403).json({ error: 'Forbidden.' });
    if (!email) return res.status(400).json({ error: 'Email required.' });
    try {
        const result = await User.deleteOne({ email: email.toLowerCase() });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ success: true, message: `Deleted user: ${email}` });
    } catch (err) { res.status(500).json({ error: 'Delete failed.' }); }
});

app.post('/admin-delete-bookings', async (req, res) => {
    const { secret, creatorName, fanEmail } = req.body;
    if (secret !== 'TOD_ADMIN_2026') return res.status(403).json({ error: 'Forbidden.' });
    try {
        const query = {};
        if (creatorName) query.creatorName = new RegExp(creatorName, 'i');
        if (fanEmail) query.fanEmail = fanEmail.toLowerCase();
        const result = await Booking.deleteMany(query);
        res.json({ success: true, deleted: result.deletedCount });
    } catch (err) { res.status(500).json({ error: 'Delete failed.' }); }
});

app.post('/create-checkout-session', async (req, res) => {
    const { selectedCard, creatorName, fanName, creatorStripeAccountId, fanEmail, bookingDate, bookingTime, note, successUrl, cancelUrl } = req.body;
    if (!selectedCard || !creatorName || !fanName) return res.status(400).json({ error: 'Missing fields.' });
    const PRICES = {
        truth: { amount: 1500, label: 'Truth Session' },
        dare:  { amount: 4500, label: 'Dare Session' },
    };
    const price = PRICES[selectedCard];
    if (!price) return res.status(400).json({ error: 'Invalid card.' });
    try {
        // Use caller-supplied URLs when provided (e.g. live session returns to creator profile to open room)
        // Fall back to generic booking-confirmed page
        const resolvedSuccessUrl = successUrl || `${FRONTEND}/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`;
        const resolvedCancelUrl  = cancelUrl  || `${FRONTEND}?canceled=1`;
        const sessionParams = {
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
                quantity: 1
            }],
            mode: 'payment',
            success_url: resolvedSuccessUrl,
            cancel_url: resolvedCancelUrl,
            metadata: { creator: creatorName, fan: fanName, type: selectedCard, bookingDate: bookingDate || '', bookingTime: bookingTime || '', note: note || '' },
        };
        if (creatorStripeAccountId) {
            sessionParams.payment_intent_data = {
                application_fee_amount: platformFee(price.amount),
                transfer_data: { destination: creatorStripeAccountId },
            };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe checkout session creation failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/onboard-creator', async (req, res) => {
    const { creatorEmail, creatorName } = req.body;
    if (!creatorEmail || !creatorName) return res.status(400).json({ error: 'Email and name required.' });
    try {
        const user = await User.findOne({ email: creatorEmail.toLowerCase() });
        let accountId = user?.stripeAccountId || null;

        // If creator already has an account, generate a new onboarding link for it
        // (handles the case where they started but didn't finish)
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                email: creatorEmail,
                capabilities: { transfers: { requested: true } },
                business_profile: { name: creatorName, url: FRONTEND },
            });
            accountId = account.id;
            await User.findOneAndUpdate({ email: creatorEmail.toLowerCase() }, { stripeAccountId: accountId });
        }

        // Check if already fully onboarded
        const account = await stripe.accounts.retrieve(accountId);
        if (account.details_submitted && account.charges_enabled) {
            // Already fully connected — return a dashboard link instead
            const loginLink = await stripe.accounts.createLoginLink(accountId);
            return res.json({ accountId, onboardingUrl: loginLink.url, alreadyConnected: true });
        }

        // Generate fresh onboarding link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${FRONTEND}/onboard-refresh.html?account=${accountId}`,
            return_url: `${FRONTEND}/onboard-complete.html?account=${accountId}`,
            type: 'account_onboarding',
        });
        res.json({ accountId, onboardingUrl: accountLink.url, alreadyConnected: false });
    } catch (err) {
        console.error('Stripe creator onboarding failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /stripe-account-status — check if a creator's Stripe account is fully onboarded
app.get('/stripe-account-status', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        if (!user.stripeAccountId) {
            return res.json({ connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false });
        }
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const fullyConnected = account.details_submitted && account.charges_enabled;
        res.json({
            connected: fullyConnected,
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            accountId: user.stripeAccountId,
        });
    } catch (err) {
        console.error('Failed to fetch Stripe account status:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/webhook', (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        const payload = req.rawBody || req.body;
        event = stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error('Stripe webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { creator: creatorName, fan: fanName, type: sessionType, bookingDate, bookingTime, bookingId } = session.metadata || {};
        const fanEmail = session.customer_details?.email || session.metadata?.fanEmail || '';
        const paymentIntentId = session.payment_intent;
        console.log(`✅ Payment confirmed: ${fanName} booked ${sessionType} with ${creatorName} — $${(session.amount_total/100).toFixed(2)} (bookingId: ${bookingId || 'legacy'})`);

        // Run async post-payment fulfillment (don't await — respond to Stripe immediately)
        (async () => {
            try {
                const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
                const sessionLabel = sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';
                const sessionMinutes = sessionType === 'truth' ? 5 : 15;

                // 1. Find the creator in the DB
                const creator = await User.findOne({ name: creatorName, role: 'creator' });
                const creatorEmail = creator ? creator.email : null;
                const creatorHandle = creator ? creator.handle : '';

                // 2. Generate a 4-digit session PIN
                const sessionPin = String(Math.floor(1000 + Math.random() * 9000));

                // 3. Create a Daily.co video room
                let roomUrl = null;
                let roomId = null;
                if (process.env.DAILY_API_KEY) {
                    try {
                        const room = await createDailyRoom(sessionType);
                        roomUrl = room.url;
                        roomId = room.name;
                        console.log(`🎥 Daily.co room created: ${roomUrl}`);
                    } catch (e) {
                        console.error('Daily.co room creation failed:', e.message);
                    }
                }
                const fanRoomLink = roomUrl && bookingRecord && bookingRecord.token
                    ? `${frontendUrl}/room.html?booking=${bookingId}&token=${encodeURIComponent(bookingRecord.token)}`
                    : null;
                const roomLink = roomUrl
                    ? `${frontendUrl}/room.html?id=${roomId}&creator=${encodeURIComponent(creatorHandle)}&type=${sessionType}&pin=${sessionPin}&booking=${bookingId}`
                    : null;

                // 4. Update the Booking record if bookingId is present
                if (bookingId) {
                    try {
                        const booking = await Booking.findById(bookingId);
                        if (booking) {
                            booking.status = 'paid';
                            booking.paymentIntentId = paymentIntentId;
                            booking.sessionPin = sessionPin;
                            if (roomId) booking.roomId = roomId;
                            if (roomUrl) booking.roomUrl = roomUrl;
                            await booking.save();
                            console.log(`📋 Booking ${bookingId} marked as paid. PIN: ${sessionPin}`);
                        }
                    } catch (e) {
                        console.error('Failed to update booking record:', e.message);
                    }
                }

                // Notify admin of payment
                const adminEmail = 'Truthordarefans@gmail.com';
                const adminHtml3 = emailTemplate({
                    title: `Payment Received!`,
                    preheader: `${fanName} paid for session with ${creatorName}`,
                    bodyHtml: `<p style="color:#FDF6EC;">A payment of $${(session.amount_total/100).toFixed(2)} was successfully processed.</p><ul><li style="color:#C9B99A;">Fan: ${fanName}</li><li style="color:#C9B99A;">Creator: ${creatorName}</li><li style="color:#C9B99A;">Type: ${sessionType}</li></ul>`,
                });
                sendEmail(adminEmail, `💰 Payment Received: $${(session.amount_total/100).toFixed(2)} from ${fanName}`, adminHtml3).catch(e => console.error(e));

                // 4. Email the creator (with income receipt)
                if (creatorEmail) {
                    const grossAmount = session.amount_total || 0;
                    const platformFee = Math.round(grossAmount * 0.15);
                    const creatorPayout = grossAmount - platformFee;
                    const creatorHtml = emailTemplate({
                        title: `🎯 Session Confirmed — ${sessionLabel}`,
                        preheader: `${fanName} has paid — your session room is ready`,
                        bodyHtml: `
                            <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;"><strong style="color:#FDF6EC;">${fanName}</strong> has completed payment. Your session room is ready!</p>
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Fan</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;font-weight:700;">${fanName}</td></tr>
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Session</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${sessionLabel} (${sessionMinutes} min)</td></tr>
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr>
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Time</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr>
                            </table>
                            <div style="margin:20px 0;padding:16px;background:rgba(80,200,120,0.07);border:1px solid rgba(80,200,120,0.3);border-radius:10px;">
                                <p style="margin:0 0 10px 0;font-size:12px;color:#9A8A72;letter-spacing:1px;text-transform:uppercase;">Income Receipt</p>
                                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                                    <tr><td style="padding:6px 0;color:#9A8A72;font-size:13px;">Session Price</td><td style="padding:6px 0;color:#FDF6EC;text-align:right;">$${(grossAmount/100).toFixed(2)}</td></tr>
                                    <tr><td style="padding:6px 0;color:#9A8A72;font-size:13px;">Platform Fee (15%)</td><td style="padding:6px 0;color:#FF9999;text-align:right;">-$${(platformFee/100).toFixed(2)}</td></tr>
                                    <tr style="border-top:1px solid rgba(80,200,120,0.3);"><td style="padding:8px 0 0;color:#50C878;font-size:14px;font-weight:700;">Your Payout (85%)</td><td style="padding:8px 0 0;color:#50C878;font-size:16px;font-weight:900;text-align:right;">$${(creatorPayout/100).toFixed(2)}</td></tr>
                                </table>
                                <p style="margin:8px 0 0;font-size:11px;color:#666;">Payout will be deposited to your connected Stripe account. Keep this email for your tax records.</p>
                            </div>
                            <div style="margin:20px 0;padding:16px;background:rgba(212,165,116,0.1);border:2px solid #D4A574;border-radius:10px;text-align:center;">
                                <p style="margin:0 0 6px 0;font-size:12px;color:#9A8A72;letter-spacing:1px;text-transform:uppercase;">Your Session PIN</p>
                                <p style="margin:0;font-size:36px;font-weight:900;color:#D4A574;letter-spacing:8px;">${sessionPin}</p>
                                <p style="margin:6px 0 0 0;font-size:12px;color:#9A8A72;">Enter this PIN when you join the session room. Your PIN has also been sent to your dashboard.</p>
                            </div>`,
                        ctaUrl: roomLink || `${frontendUrl}/dashboard`,
                        ctaText: roomLink ? '▶ Start Session Now' : '📊 Go to Dashboard',
                        footerNote: 'Log into your creator dashboard to manage this booking. Keep this email for your tax records.'
                    });
                    await sendEmail(creatorEmail, `💰 Income Receipt: $${(creatorPayout/100).toFixed(2)} from ${fanName}'s ${sessionLabel}`, creatorHtml);
                }

                // 5. Email the fan
                if (fanEmail) {
                    const fanHtml = emailTemplate({
                        title: '✅ You’re All Set!',
                        preheader: `Your ${sessionLabel} with ${creatorName} is confirmed and paid`,
                        bodyHtml: `
                            <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;">Your <strong style="color:#FDF6EC;">${sessionLabel}</strong> with <strong style="color:#FDF6EC;">${creatorName}</strong> is booked and paid. Your session room is ready!</p>
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Session</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${sessionLabel} (${sessionMinutes} min)</td></tr>
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Creator</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${creatorName}</td></tr>
                                <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr>
                                <tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Time</td><td style="padding:9px 0;color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr>
                            </table>
                            <div style="margin:20px 0;padding:16px;background:rgba(212,165,116,0.1);border:2px solid #D4A574;border-radius:10px;text-align:center;">
                                <p style="margin:0 0 6px 0;font-size:12px;color:#9A8A72;letter-spacing:1px;text-transform:uppercase;">Your Session PIN</p>
                                <p style="margin:0;font-size:36px;font-weight:900;color:#D4A574;letter-spacing:8px;">${sessionPin}</p>
                                <p style="margin:6px 0 0 0;font-size:12px;color:#9A8A72;">You'll need this PIN to enter the session room. Keep it safe — it's also saved in your dashboard.</p>
                            </div>`,
                        ctaUrl: roomLink || `${frontendUrl}/fan-dashboard.html`,
                        ctaText: roomLink ? '▶ Join Your Session' : '📊 Go to Your Dashboard',
                        footerNote: 'Questions? Reply to this email or visit truthordareformyfans.com'
                    });
                    await sendEmail(fanEmail, `✅ Your ${sessionLabel} with ${creatorName} is confirmed`, fanHtml);
                }

                console.log(`📧 Post-payment emails sent — creator: ${creatorEmail}, fan: ${fanEmail}`);
            } catch (err) {
                console.error('Post-payment fulfillment error:', err.message);
            }
        })();
    }
    // Handle extension payment
    if (event.type === 'checkout.session.completed') {
        const session2 = event.data.object;
        if (session2.metadata?.action === 'extend') {
            (async () => {
                try {
                    const { bookingId, extensionType } = session2.metadata;
                    const addMinutes = extensionType === 'dare' ? 15 : 5;
                    await Booking.findByIdAndUpdate(bookingId, {
                        extensionStatus: 'extended',
                        extensionPending: null
                    });
                    console.log(`⏱ Extension paid for booking ${bookingId}: +${addMinutes} min (${extensionType})`);
                } catch (e) {
                    console.error('Extension webhook error:', e.message);
                }
            })();
        }
    }
    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
});

app.post('/featured-apply', async (req, res) => {
    const { name, email, bio, platform, photo } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    try {
        const existing = await Featured.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'Application already exists.' });
        await Featured.create({ name, email: email.toLowerCase(), bio: bio || '', platform: platform || '', photo: photo || null });
        // Optionally send an email notification to admin
        if (process.env.ADMIN_EMAIL) {
            // Assuming sendEmail function exists and is configured
            // await sendEmail(process.env.ADMIN_EMAIL, `⭐ New Creator Application: ${name}`, `<h2>New Application</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Bio:</strong> ${bio || 'N/A'}</p>`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Featured creator application failed:', err);
        res.status(500).json({ error: 'Submission failed.' });
    }
});

app.get('/featured-creators', async (req, res) => {
    try {
        const creators = await Featured.find({ approved: true }, { email: 0 }).sort({ createdAt: -1 });
        res.json({ creators });
    } catch (err) {
        console.error('Failed to fetch featured creators:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

app.post('/featured-approve', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    try {
        await Featured.findByIdAndUpdate(req.body.id, { approved: req.body.approved });
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to approve featured creator:', err);
        res.status(500).json({ error: 'Could not update.' });
    }
});

app.post('/create-room', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const room = await createDailyRoom(req.body.sessionType);
        res.json({ roomId: room.name, url: room.url });
    } catch (err) {
        console.error('Failed to create Daily.co room:', err);
        res.status(500).json({ error: 'Could not create room.' });
    }
});

app.get('/get-room/:roomId', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const r = await fetch(`https://api.daily.co/v1/rooms/${req.params.roomId}`, {
            headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` }
        });
        res.json({ url: (await r.json()).url });
    } catch (err) {
        console.error('Failed to fetch Daily.co room:', err);
        res.status(500).json({ error: 'Could not fetch room.' });
    }
});

// GET /fan-room/:bookingId?token=... — public token-gated room access for fans (no login required)
app.get('/fan-room/:bookingId', async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required.' });
    try {
        const booking = await Booking.findById(req.params.bookingId);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.token !== token) return res.status(403).json({ error: 'Invalid token.' });
        if (booking.status !== 'paid' && booking.status !== 'confirmed') return res.status(403).json({ error: 'Booking not paid.' });
        if (!booking.roomId) return res.status(404).json({ error: 'Room not ready yet.' });
        res.json({
            url: booking.roomUrl,
            roomId: booking.roomId,
            sessionPin: booking.sessionPin,
            sessionType: booking.sessionType,
            creatorName: booking.creatorName,
            fanName: booking.fanName,
            requestedDate: booking.requestedDate,
            requestedTime: booking.requestedTime
        });
    } catch (err) {
        console.error('Failed to fetch fan room:', err);
        res.status(500).json({ error: 'Could not fetch room.' });
    }
});

// POST /fan-room-chat/:roomId — public chat post for fans (token-gated)
app.post('/fan-room-chat/:roomId', async (req, res) => {
    const { message, name, token, bookingId } = req.body;
    if (!message || !token || !bookingId) return res.status(400).json({ error: 'Missing fields.' });
    try {
        const booking = await Booking.findById(bookingId);
        if (!booking || booking.token !== token) return res.status(403).json({ error: 'Invalid token.' });
        await ChatMessage.create({ roomId: req.params.roomId, name: name || booking.fanName, role: 'fan', message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not save.' });
    }
});

app.post('/room-chat/:roomId', requireAuth, async (req, res) => {
    if (!req.body.message) return res.status(400).json({ error: 'Message required.' });
    try {
        await ChatMessage.create({ roomId: req.params.roomId, name: req.body.name, role: req.body.role, message: req.body.message });
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to save chat message:', err);
        res.status(500).json({ error: 'Could not save.' });
    }
});

app.get('/room-chat/:roomId', async (req, res) => {
    const since = parseInt(req.query.since) || 0;
    try {
        const messages = await ChatMessage.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });
        res.json({ messages: messages.slice(since) });
    } catch (err) {
        console.error('Failed to fetch chat messages:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

// ── CREATOR DASHBOARD ENDPOINTS ──────────────────────────────────────────────

// GET /creator/profile — returns the logged-in creator's profile
app.get('/creator/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-passwordHash');
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        res.json({ user });
    } catch (err) {
        console.error('Failed to fetch creator profile:', err);
        res.status(500).json({ error: 'Could not fetch profile.' });
    }
});

// PUT /creator/profile — update name, bio, photo, handle
app.put('/creator/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const { name, bio, photo, handle, extraPhotos, socials, notificationPrefs } = req.body;
        if (name) user.name = name;
        if (bio !== undefined) user.bio = bio;
        if (photo !== undefined) user.photo = photo;
        if (extraPhotos !== undefined) user.extraPhotos = extraPhotos.slice(0, 4); // max 4 extra photos
        if (handle) {
            let h = handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            user.handle = h ? `${h}@truthordare` : user.handle;
        }
        if (socials) {
            user.socials = { ...user.socials, ...socials };
        }
        if (notificationPrefs) {
            user.notificationPrefs = {
                email: notificationPrefs.email !== undefined ? !!notificationPrefs.email : (user.notificationPrefs?.email ?? true),
                sms: notificationPrefs.sms !== undefined ? !!notificationPrefs.sms : (user.notificationPrefs?.sms ?? false),
                phone: notificationPrefs.phone !== undefined ? notificationPrefs.phone : (user.notificationPrefs?.phone ?? null),
                customHandle: notificationPrefs.customHandle !== undefined ? notificationPrefs.customHandle : (user.notificationPrefs?.customHandle ?? null),
            };
        }
        await user.save();
        res.json({ success: true, user: { name: user.name, bio: user.bio, photo: user.photo, handle: user.handle, extraPhotos: user.extraPhotos || [], socials: user.socials || {}, notificationPrefs: user.notificationPrefs || {} } });
    } catch (err) {
        console.error('Failed to update creator profile:', err);
        res.status(500).json({ error: 'Could not update profile.' });
    }
});

// PUT /creator/availability — toggle live/offline status
app.put('/creator/availability', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.isLive = req.body.isLive === true;
        await user.save();
        console.log(`Creator ${user.name} is now ${user.isLive ? 'LIVE 🔴' : 'OFFLINE ⚫'}`);
        res.json({ success: true, isLive: user.isLive });
    } catch (err) {
        console.error('Failed to update availability:', err);
        res.status(500).json({ error: 'Could not update availability.' });
    }
});

// PUT /creator/session-status — set inSession true/false (called by room.html)
app.put('/creator/session-status', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.inSession = req.body.inSession === true;
        await user.save();
        console.log(`Creator ${user.name} is now ${user.inSession ? 'IN SESSION 🔴' : 'NOT in session'}`);
        res.json({ success: true, inSession: user.inSession });
    } catch (err) {
        res.status(500).json({ error: 'Could not update session status.' });
    }
});

// POST /creator/heartbeat — dashboard pings every 60s to stay online
app.post('/creator/heartbeat', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.lastHeartbeat = new Date();
        await user.save();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Heartbeat failed.' }); }
});

// GET /vapid-public-key — returns the VAPID public key for push subscription
app.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC });
});

// POST /creator/push-subscribe — save push subscription for creator
app.post('/creator/push-subscribe', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.pushSubscription = req.body.subscription;
        await user.save();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Could not save subscription.' }); }
});

// DELETE /creator/push-subscribe — remove push subscription (unsubscribe)
app.delete('/creator/push-subscribe', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.pushSubscription = null;
        await user.save();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Could not remove subscription.' }); }
});

// POST /booking/:id/fan-in-room — fan signals they've entered the room; notifies creator
app.post('/booking/:id/fan-in-room', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        booking.fanInRoom = true;
        await booking.save();

        // Find creator and send push notification
        const creator = await User.findOne({ email: booking.creatorEmail, role: 'creator' });
        if (creator && creator.pushSubscription) {
            const sessionLabel = booking.sessionType === 'truth' ? 'Truth Session' : 'Dare Session';
            const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
            const roomLink = booking.roomId
                ? `${frontendUrl}/room.html?id=${booking.roomId}&creator=${encodeURIComponent(creator.handle || creator.name)}&type=${booking.sessionType}&pin=${booking.sessionPin}&booking=${booking._id}`
                : `${frontendUrl}/dashboard`;
            try {
                await webpush.sendNotification(
                    creator.pushSubscription,
                    JSON.stringify({
                        title: '🔴 Fan is waiting in the room!',
                        body: `${booking.fanName} has joined the ${sessionLabel} — join now!`,
                        url: roomLink
                    })
                );
            } catch (e) { console.warn('Push to creator failed:', e.message); }
        }

        // Also send email to creator
        if (creator) {
            const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
            const roomLink = booking.roomId
                ? `${frontendUrl}/room.html?id=${booking.roomId}&creator=${encodeURIComponent(creator.handle || creator.name)}&type=${booking.sessionType}&pin=${booking.sessionPin}&booking=${booking._id}`
                : `${frontendUrl}/dashboard`;
            const sessionLabel = booking.sessionType === 'truth' ? 'Truth Session' : 'Dare Session';
            const bodyHtml = `
                <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;"><strong style="color:#FDF6EC;">${booking.fanName}</strong> is in the session room and waiting for you!</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,50,50,0.1);border:1px solid rgba(255,80,80,0.4);border-radius:8px;padding:16px;margin-bottom:20px;"><tr><td>
                    <p style="margin:0;font-size:14px;color:#FDF6EC;">🔴 <strong>${sessionLabel}</strong> — fan is waiting now</p>
                    <p style="margin:6px 0 0 0;font-size:13px;color:#C9B99A;">Join the room immediately to start the session.</p>
                </td></tr></table>`;
            try {
                await sendEmail(
                    creator.email,
                    `🔴 ${booking.fanName} is waiting in the room — join now!`,
                    emailTemplate({ title: '🔴 Fan Is Waiting!', preheader: `${booking.fanName} is in the session room`, bodyHtml, ctaUrl: roomLink, ctaText: '▶ Join Session Now' })
                );
            } catch (e) { console.warn('Email to creator failed:', e.message); }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('fan-in-room error:', err);
        res.status(500).json({ error: 'Could not update fan-in-room status.' });
    }
});

// GET /booking/:id/confirm-payment — called by booking-confirmed.html to verify payment actually happened
app.get('/booking/:id/confirm-payment', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        // If already paid (webhook already fired), return success immediately
        if (booking.status === 'paid' || booking.paymentIntentId) {
            return res.json({
                paid: true,
                status: booking.status,
                sessionPin: booking.sessionPin,
                roomId: booking.roomId,
                roomUrl: booking.roomUrl,
                sessionType: booking.sessionType,
                creatorName: booking.creatorName,
                fanName: booking.fanName,
            });
        }
        // Not yet paid - return pending
        return res.json({ paid: false, status: booking.status });
    } catch (err) { res.status(500).json({ error: 'Could not verify payment.' }); }
});

// GET /booking/:id/status — returns fanInRoom and other status fields (polled by creator dashboard)
app.get('/booking/:id/status', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id, 'fanInRoom status roomId roomUrl sessionPin sessionType fanName');
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        res.json(booking);
    } catch (err) { res.status(500).json({ error: 'Could not fetch booking status.' }); }
});

// Auto-offline: every 2 minutes, mark creators offline if no heartbeat in 5 minutes
setInterval(async () => {
    try {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
        const result = await User.updateMany(
            { role: 'creator', isLive: true, lastHeartbeat: { $lt: cutoff } },
            { $set: { isLive: false } }
        );
        if (result.modifiedCount > 0) {
            console.log(`⚫ Auto-offline: marked ${result.modifiedCount} creator(s) offline (no heartbeat)`);
        }
    } catch (err) { console.error('Auto-offline check failed:', err.message); }
}, 2 * 60 * 1000); // run every 2 minutes

// POST /creator/feature-request — request to be featured on homepage
app.post('/creator/feature-request', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const { bio, photo } = req.body;
        // Update user's featured request fields
        user.featuredRequested = true;
        if (bio !== undefined) user.bio = bio;
        if (photo !== undefined) user.photo = photo;
        if (extraPhotos !== undefined) user.extraPhotos = extraPhotos.slice(0, 4); // max 4 extra photos
        await user.save();
        // Create or update Featured entry (pending approval)
        const existing = await Featured.findOne({ email: user.email });
        if (existing) {
            existing.name = user.name;
            existing.bio = user.bio || '';
            existing.photo = user.photo || null;
            existing.approved = false; // Reset to pending on re-apply
            await existing.save();
        } else {
            await Featured.create({ name: user.name, email: user.email, bio: user.bio || '', photo: user.photo || null });
        }
        console.log(`⭐ Creator ${user.name} requested to be featured — pending admin approval.`);
        res.json({ success: true, message: 'Feature request submitted. Pending admin approval.' });
    } catch (err) {
        console.error('Failed to submit feature request:', err);
        res.status(500).json({ error: 'Could not submit request.' });
    }
});

// DELETE /creator/feature-request — remove from featured
app.delete('/creator/feature-request', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.featuredRequested = false;
        await user.save();
        await Featured.findOneAndDelete({ email: user.email });
        res.json({ success: true, message: 'Removed from featured.' });
    } catch (err) {
        console.error('Failed to remove feature request:', err);
        res.status(500).json({ error: 'Could not remove.' });
    }
});

// GET /creator/sessions — returns sessions for the logged-in creator
app.get('/creator/sessions', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const sessions = await Booking.find({ creatorEmail: user.email }).sort({ createdAt: -1 }).limit(50);
        res.json({ sessions });
    } catch (err) {
        console.error('Failed to fetch creator sessions:', err);
        res.status(500).json({ error: 'Could not fetch sessions.' });
    }
});

// GET /creator/earnings — returns earnings summary for the logged-in creator
app.get('/creator/earnings', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const sessions = await Booking.find({ creatorEmail: user.email, status: { $in: ['confirmed', 'paid', 'accepted'] } }).sort({ createdAt: -1 });
        const PRICES = { truth: 1500, dare: 4500 };
        const totalGross = sessions.reduce((sum, s) => sum + (PRICES[s.sessionType] || 0), 0);
        const totalEarnings = Math.round(totalGross * 0.85); // 85% to creator
        const sessionBreakdown = sessions.map(s => ({
            id: s._id,
            fanName: s.fanName,
            sessionType: s.sessionType,
            gross: (PRICES[s.sessionType] || 0) / 100,
            payout: Math.round((PRICES[s.sessionType] || 0) * 0.85) / 100,
            date: s.updatedAt || s.createdAt,
            status: s.status,
        }));
        res.json({
            totalSessions: sessions.length,
            totalGrossUSD: (totalGross / 100).toFixed(2),
            totalEarningsUSD: (totalEarnings / 100).toFixed(2),
            stripeConnected: !!user.stripeAccountId,
            stripeAccountId: user.stripeAccountId || null,
            sessions: sessionBreakdown,
        });
    } catch (err) {
        console.error('Failed to fetch creator earnings:', err);
        res.status(500).json({ error: 'Could not fetch earnings.' });
    }
});

// ── END CREATOR DASHBOARD ENDPOINTS ───────────────────────────────────────────

// ── BOOKING ENDPOINTS ─────────────────────────────────────────────────────────

// POST /booking — fan submits a booking REQUEST (no payment yet)
app.post('/booking', async (req, res) => {
    let { fanName, fanEmail, creatorHandle, sessionType, requestedDate, requestedTime, note } = req.body;
    // Handle "Now / Immediately" slot — convert to actual current date/time
    if (requestedDate === 'now' || requestedTime === 'now') {
        const now = new Date();
        requestedDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
        requestedTime = now.toTimeString().slice(0, 5);  // HH:MM
    }
    if (!fanName || !fanEmail || !creatorHandle || !sessionType || !requestedDate || !requestedTime) {
        return res.status(400).json({ error: 'Missing required booking fields.' });
    }
    try {
        const normalizedHandle = creatorHandle.replace(/^@/, '');
        const creator = await User.findOne({ handle: normalizedHandle });
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        const booking = await Booking.create({
            fanName, fanEmail,
            creatorName: creator.name,
            creatorEmail: creator.email,
            sessionType,
            requestedDate,
            requestedTime,
            note: note || null,
            status: 'pending',
        });

        // Notify admin
        const adminEmail = 'Truthordarefans@gmail.com';
        const adminHtml2 = emailTemplate({
            title: `New Booking Request`,
            preheader: `${fanName} requested a session with ${creator.name}`,
            bodyHtml: `<p style="color:#FDF6EC;">A new booking request was just submitted!</p><ul><li style="color:#C9B99A;">Fan: ${fanName}</li><li style="color:#C9B99A;">Creator: ${creator.name}</li><li style="color:#C9B99A;">Type: ${sessionType}</li><li style="color:#C9B99A;">Date: ${requestedDate}</li><li style="color:#C9B99A;">Time: ${requestedTime}</li></ul>`,
        });
        sendEmail(adminEmail, `📅 New Booking Request: ${fanName} for ${creator.name}`, adminHtml2).catch(e => console.error(e));

        // Email the creator about the new request
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const sessionLabel = sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';
        const creatorHtml = emailTemplate({
            title: `🎯 New Booking Request`,
            preheader: `${fanName} wants to book a ${sessionLabel} with you`,
            bodyHtml: `
                <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;">A fan wants to book a session with you. Log into your dashboard to accept, propose a new time, or decline.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Fan name</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;font-weight:700;">${fanName}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Fan email</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${fanEmail}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Session type</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${sessionLabel}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Requested date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${requestedDate}</td></tr>
                    <tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Requested time</td><td style="padding:9px 0;color:#FDF6EC;">${requestedTime}</td></tr>
                    ${note ? `<tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Note from fan</td><td style="padding:9px 0;color:#FDF6EC;font-style:italic;">${note}</td></tr>` : ''}
                </table>`,
            ctaUrl: `${frontendUrl}/dashboard`,
            ctaText: '📅 Respond in Dashboard',
            footerNote: 'You received this because a fan booked a session with you on Truth or Dare For My Fans.'
        });
        // Send emails non-blocking so booking succeeds even if email fails
        sendEmail(creator.email, `🎯 New booking request from ${fanName}`, creatorHtml)
            .catch(e => console.error('Creator email failed:', e.message));

        // Email the fan confirming their request was sent
        const fanHtml = emailTemplate({
            title: '📨 Booking Request Sent!',
            preheader: `Your request to ${creator.name} has been received`,
            bodyHtml: `
                <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;">Your booking request has been sent to <strong style="color:#FDF6EC;">${creator.name}</strong>. You'll receive an email once they confirm your time slot — then you'll be able to complete payment.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Session type</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${sessionLabel}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Requested date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${requestedDate}</td></tr>
                    <tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Requested time</td><td style="padding:9px 0;color:#FDF6EC;">${requestedTime}</td></tr>
                </table>
                <p style="font-size:13px;color:#9A8A72;margin-top:16px;">No payment has been taken yet. You will only be charged once the creator confirms your booking.</p>`,
            footerNote: 'You received this because you submitted a booking request on Truth or Dare For My Fans.'
        });
        sendEmail(fanEmail, `📨 Booking request sent to ${creator.name}`, fanHtml)
            .catch(e => console.error('Fan email failed:', e.message));

        // Send browser push notification to creator if subscribed
        if (creator.pushSubscription) {
            const pushPayload = JSON.stringify({
                title: '🔔 New Booking Request!',
                body: `${fanName} wants a ${sessionLabel} on ${requestedDate} at ${requestedTime}`,
                url: '/dashboard.html'
            });
            webpush.sendNotification(creator.pushSubscription, pushPayload)
                .catch(err => {
                    console.error('Push notification failed:', err.message);
                    // If subscription is expired/invalid, clear it
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        User.findByIdAndUpdate(creator._id, { pushSubscription: null }).catch(() => {});
                    }
                });
        }

        res.status(201).json({ success: true, bookingId: booking._id });
    } catch (err) {
        console.error('Booking creation failed:', err);
        res.status(500).json({ error: 'Could not create booking.' });
    }
});

// POST /booking/:id/generate-payment-link — creator accepted, generate Stripe payment link for fan
app.post('/booking/:id/generate-payment-link', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.creatorEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });

        const PRICES = { truth: { amount: 1500, label: 'Truth Session' }, dare: { amount: 4500, label: 'Dare Session' } };
        const price = PRICES[booking.sessionType];
        if (!price) return res.status(400).json({ error: 'Invalid session type.' });

        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const confirmedDate = booking.proposedDate || booking.requestedDate;
        const confirmedTime = booking.proposedTime || booking.requestedTime;

        // Generate a secure random token for fan-view auth
        const fanToken = crypto.randomBytes(24).toString('hex');

        // Save the token and mark as accepted
        booking.token = fanToken;
        booking.status = 'accepted';
        await booking.save();

        const confirmUrl = `${frontendUrl}/confirm.html?id=${booking._id}&token=${encodeURIComponent(fanToken)}`;

        // Email the fan with the confirmation link
        const fanHtml = emailTemplate({
            title: '🎉 Your Booking is Accepted!',
            preheader: `${user.name} accepted your session — complete payment to lock in your spot`,
            bodyHtml: `
                <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;"><strong style="color:#FDF6EC;">${user.name}</strong> has accepted your session request. Click below to complete payment and lock in your spot!</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Session</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${price.label}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Creator</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${user.name}</td></tr>
                    <tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Confirmed date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${confirmedDate}</td></tr>
                    <tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Confirmed time</td><td style="padding:9px 0;color:#FDF6EC;">${confirmedTime}</td></tr>
                </table>`,
            ctaUrl: confirmUrl,
            ctaText: '💳 Complete Payment Now',
            footerNote: 'You received this because a creator accepted your booking on Truth or Dare For My Fans.'
        });
        sendEmail(booking.fanEmail, `🎉 ${user.name} accepted your booking — complete payment now`, fanHtml)
            .catch(e => console.error('Payment link email failed:', e.message));

        res.json({ success: true });
    } catch (err) {
        console.error('Generate payment link failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /booking/:id/counter-propose — creator proposes up to 3 alternative times
app.post('/booking/:id/counter-propose', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.creatorEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });

        const { proposals } = req.body; // Array of {date, time} objects, max 3
        if (!proposals || !Array.isArray(proposals) || proposals.length === 0 || proposals.length > 3) {
            return res.status(400).json({ error: 'Please provide 1 to 3 time proposals.' });
        }
        for (const p of proposals) {
            if (!p.date || !p.time) return res.status(400).json({ error: 'Each proposal must have a date and time.' });
        }

        booking.counterProposals = proposals;
        booking.status = 'proposed';
        await booking.save();

        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const sessionLabel = booking.sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';

        // Build proposal list HTML
        const proposalRows = proposals.map((p, i) => `<tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Option ${i+1}</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${p.date} at ${p.time}</td></tr>`).join('');

        const fanHtml = emailTemplate({
            title: '📅 Creator Proposed New Times',
            preheader: `${user.name} suggested alternative times for your session`,
            bodyHtml: `
                <p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;"><strong style="color:#FDF6EC;">${user.name}</strong> has proposed alternative times for your <strong style="color:#D4A574;">${sessionLabel}</strong>. Log into your dashboard to pick a time and complete payment.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                    ${proposalRows}
                </table>`,
            ctaUrl: `${frontendUrl}/fan-dashboard.html`,
            ctaText: '📅 Choose a Time & Pay',
            footerNote: 'You received this because a creator responded to your booking request on Truth or Dare For My Fans.'
        });
        sendEmail(booking.fanEmail, `📅 ${user.name} proposed new times for your session`, fanHtml)
            .catch(e => console.error('Counter-proposal email failed:', e.message));

        res.json({ success: true });
    } catch (err) {
        console.error('Counter-propose failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /booking/:id/fan-choose — fan picks one of the counter-proposed times
app.post('/booking/:id/fan-choose', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'fan') return res.status(403).json({ error: 'Fan only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.fanEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });
        if (booking.status !== 'proposed') return res.status(400).json({ error: 'No counter-proposal to respond to.' });

        const { date, time } = req.body;
        if (!date || !time) return res.status(400).json({ error: 'Please provide a date and time.' });

        booking.fanChosenDate = date;
        booking.fanChosenTime = time;
        booking.proposedDate = date;
        booking.proposedTime = time;
        booking.status = 'accepted';

        // Generate a secure token for payment link
        const fanToken = require('crypto').randomBytes(24).toString('hex');
        booking.token = fanToken;
        await booking.save();

        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const confirmUrl = `${frontendUrl}/confirm.html?id=${booking._id}&token=${encodeURIComponent(fanToken)}`;

        res.json({ success: true, paymentUrl: confirmUrl });
    } catch (err) {
        console.error('Fan choose failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── FAN ENDPOINTS ──────────────────────────────────────────────────────────

// GET /fan/bookings — fan sees all their bookings
app.get('/fan/bookings', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'fan') return res.status(403).json({ error: 'Fan only.' });
        const bookings = await Booking.find({ fanEmail: user.email }).sort({ createdAt: -1 });
        res.json({ bookings });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch bookings.' });
    }
});

// GET /fan/profile — fan sees their own profile
app.get('/fan/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('name email role createdAt');
        if (!user || user.role !== 'fan') return res.status(403).json({ error: 'Fan only.' });
        res.json({ user });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch profile.' });
    }
});

// GET /creator/bookings — creator sees all pending/upcoming bookings
app.get('/creator/bookings', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const bookings = await Booking.find({ creatorEmail: user.email, status: { $in: ['pending', 'accepted', 'confirmed', 'proposed', 'paid'] } }).sort({ createdAt: -1 });
        res.json({ bookings });
    } catch (err) {
        console.error('Failed to fetch bookings:', err);
        res.status(500).json({ error: 'Could not fetch bookings.' });
    }
});

// GET /booking/:id/fan-view — public endpoint for fans to view their booking (token-gated)
app.get('/booking/:id/fan-view', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        // Token must match the Stripe session ID stored on the booking, OR a simple fan token
        const { token } = req.query;
        if (!token || booking.token !== token) return res.status(403).json({ error: 'Invalid or expired link.' });
        const creator = await User.findOne({ email: booking.creatorEmail });
        res.json({
            booking: {
                _id: booking._id,
                status: booking.status,
                sessionType: booking.sessionType,
                requestedDate: booking.requestedDate,
                requestedTime: booking.requestedTime,
                proposedDate: booking.proposedDate,
                proposedTime: booking.proposedTime,
                fanName: booking.fanName,
                creatorHandle: creator ? creator.handle : booking.creatorName,
                note: booking.note,
            }
        });
    } catch (err) {
        console.error('Fan view error:', err);
        res.status(500).json({ error: 'Could not load booking.' });
    }
});

// POST /booking/:id/checkout — fan initiates Stripe checkout after creator accepted
app.post('/booking/:id/checkout', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        const { token } = req.body;
        if (!token || booking.token !== token) return res.status(403).json({ error: 'Invalid or expired link.' });
        if (!['accepted', 'proposed'].includes(booking.status)) {
            return res.status(400).json({ error: 'This booking is not awaiting payment.' });
        }
        const creator = await User.findOne({ email: booking.creatorEmail });
        const PRICES = { truth: { amount: 1500, label: 'Truth Session' }, dare: { amount: 4500, label: 'Dare Session' } };
        const price = PRICES[booking.sessionType];
        if (!price) return res.status(400).json({ error: 'Invalid session type.' });
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const confirmedDate = booking.proposedDate || booking.requestedDate;
        const confirmedTime = booking.proposedTime || booking.requestedTime;
        const sessionParams = {
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'usd', product_data: { name: `${price.label} with ${creator ? creator.name : booking.creatorName}`, description: `Confirmed for ${confirmedDate} at ${confirmedTime}` }, unit_amount: price.amount }, quantity: 1 }],
            mode: 'payment',
            customer_email: booking.fanEmail,
            success_url: `${frontendUrl}/booking-confirmed.html?booking=${booking._id}`,
            cancel_url: `${frontendUrl}/confirm.html?id=${booking._id}&token=${encodeURIComponent(token)}`,
            metadata: {
                creator: creator ? creator.name : booking.creatorName,
                fan: booking.fanName,
                type: booking.sessionType,
                bookingDate: confirmedDate,
                bookingTime: confirmedTime,
                bookingId: booking._id.toString(),
                note: booking.note || '',
            },
        };
        if (creator && creator.stripeAccountId) {
            sessionParams.payment_intent_data = {
                application_fee_amount: Math.round(price.amount * 0.15),
                transfer_data: { destination: creator.stripeAccountId },
            };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url });
    } catch (err) {
        console.error('Fan checkout failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /booking/:id/respond — creator accepts, declines, or proposes new time
app.put('/booking/:id/respond', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.creatorEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });
        const { action, proposedDate, proposedTime } = req.body;
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const sessionLabel = booking.sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';

        if (action === 'decline') {
            booking.status = 'declined';
            await booking.save();
            // Email the fan
            const fanHtml = `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                    <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">Booking Update</h2>
                    <p style="font-size:15px;margin-bottom:16px;">Unfortunately, <strong style="color:#FDF6EC;">${user.name}</strong> was unable to accept your booking request for a <strong>${sessionLabel}</strong>. No payment has been taken.</p>
                    <p style="font-size:13px;color:#9A8A72;">You can visit their profile to request a different time, or browse other creators at <a href="${frontendUrl}" style="color:#D4A574;">truthordareformyfans.com</a>.</p>
                </div>`;
            sendEmail(booking.fanEmail, `Booking update from ${user.name}`, fanHtml)
                .catch(e => console.error('Decline email failed:', e.message));
        } else if (action === 'propose') {
            if (!proposedDate || !proposedTime) return res.status(400).json({ error: 'proposedDate and proposedTime required.' });
            booking.status = 'proposed';
            booking.proposedDate = proposedDate;
            booking.proposedTime = proposedTime;
            // Generate a fan-view token if not already set
            if (!booking.token) booking.token = crypto.randomBytes(24).toString('hex');
            await booking.save();
            const confirmUrl = `${frontendUrl}/confirm.html?id=${booking._id}&token=${encodeURIComponent(booking.token)}`;
            const fanHtml = `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                    <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">📅 New Time Proposed</h2>
                    <p style="font-size:15px;margin-bottom:16px;"><strong style="color:#FDF6EC;">${user.name}</strong> has proposed a new time for your <strong>${sessionLabel}</strong>.</p>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Proposed date</td><td style="padding:8px 0;color:#FDF6EC;font-weight:700;">${proposedDate}</td></tr>
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Proposed time</td><td style="padding:8px 0;color:#FDF6EC;">${proposedTime}</td></tr>
                    </table>
                    <p style="font-size:14px;color:#C9B99A;margin-bottom:20px;">If this time works for you, click below to complete payment and confirm your session.</p>
                    <a href="${confirmUrl}" style="display:inline-block;background:#D4A574;color:#120500;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;">💳 View &amp; Pay Now</a>
                    <p style="font-size:12px;color:#9A8A72;margin-top:20px;">If this time doesn't work, please contact the creator directly.</p>
                </div>`;
            sendEmail(booking.fanEmail, `📅 ${user.name} proposed a new time for your session`, fanHtml)
                .catch(e => console.error('Propose email failed:', e.message));
        } else {
            return res.status(400).json({ error: 'Invalid action. Use generate-payment-link to accept.' });
        }
        res.json({ success: true, booking });
    } catch (err) {
        console.error('Booking response failed:', err);
        res.status(500).json({ error: 'Could not update booking.' });
    }
});

// POST /booking/:id/refuse-challenge — creator refuses challenge during live session, triggers full refund
app.post('/booking/:id/refuse-challenge', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.creatorEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });

        // Issue a full Stripe refund if we have a paymentIntentId
        let refundIssued = false;
        if (booking.paymentIntentId) {
            try {
                await stripe.refunds.create({ payment_intent: booking.paymentIntentId });
                refundIssued = true;
                console.log(`💸 Refund issued for booking ${booking._id} — paymentIntent ${booking.paymentIntentId}`);
            } catch (e) {
                console.error('Stripe refund failed:', e.message);
            }
        }

        booking.status = 'refused';
        await booking.save();

        // Email the fan about the refund
        if (booking.fanEmail) {
            const fanHtml = `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                    <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">Session Update</h2>
                    <p style="font-size:15px;margin-bottom:16px;">The creator was unable to complete this challenge. <strong style="color:#FDF6EC;">You have been fully refunded.</strong></p>
                    <p style="font-size:13px;color:#9A8A72;">Your refund will appear on your card within 5–10 business days depending on your bank.</p>
                    <p style="font-size:12px;color:#9A8A72;margin-top:20px;">We apologise for the inconvenience. Visit <a href="https://www.truthordareformyfans.com" style="color:#D4A574;">truthordareformyfans.com</a> to book with another creator.</p>
                </div>`;
            try { await sendEmail(booking.fanEmail, '💸 Your session has been refunded', fanHtml); } catch(e) {}
        }

        // Clear inSession status for creator
        user.inSession = false;
        await user.save();

        res.json({ success: true, refundIssued });
    } catch (err) {
        console.error('Refuse challenge failed:', err);
        res.status(500).json({ error: 'Could not process refusal.' });
    }
});

// POST /booking/:id/verify-pin — verify the session PIN
app.post('/booking/:id/verify-pin', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ valid: false, error: 'Booking not found' });
        if (!booking.sessionPin) return res.json({ valid: true }); // No PIN set — allow entry
        const { pin } = req.body;
        if (String(booking.sessionPin) === String(pin)) {
            res.json({ valid: true });
        } else {
            res.json({ valid: false });
        }
    } catch (err) {
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

// POST /booking/:id/request-extension — fan requests session extension
app.post('/booking/:id/request-extension', async (req, res) => {
    try {
        const { extensionType } = req.body;
        await Booking.findByIdAndUpdate(req.params.id, {
            extensionPending: extensionType || 'truth',
            extensionStatus: 'requested'
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /booking/:id/respond-extension — creator accepts or declines extension
app.post('/booking/:id/respond-extension', requireAuth, async (req, res) => {
    try {
        const { accepted } = req.body;
        await Booking.findByIdAndUpdate(req.params.id, {
            extensionStatus: accepted ? 'accepted' : 'declined'
        });
        res.json({ success: true, status: accepted ? 'accepted' : 'declined' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /booking/:id/extension-status — poll for extension status
app.get('/booking/:id/extension-status', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id).select('extensionStatus extensionPending');
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        res.json({
            status: booking.extensionStatus || 'none',
            extensionType: booking.extensionPending || 'truth'
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /booking/:id/extend-checkout — Stripe checkout for session extension
app.post('/booking/:id/extend-checkout', requireAuth, async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const { extensionType } = req.body;
        const isDare = extensionType === 'dare';
        const amount = isDare ? 4500 : 1500;
        const label = isDare ? 'Dare Session Extension (+15 min)' : 'Truth Session Extension (+5 min)';
        const roomUrl = `${FRONTEND}/room.html?id=${booking.roomId}&booking=${booking._id}&type=${extensionType}&extended=1`;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'usd', product_data: { name: label }, unit_amount: amount }, quantity: 1 }],
            mode: 'payment',
            success_url: roomUrl + '&ext_success=1',
            cancel_url: roomUrl,
            metadata: { bookingId: booking._id.toString(), extensionType, action: 'extend' },
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Extension checkout error:', err);
        res.status(500).json({ error: 'Could not create extension checkout' });
    }
});

// Return all creators who have a handle set (for the homepage browse grid)
app.get('/all-creators', async (req, res) => {
    try {
        const creators = await User.find(
            { role: 'creator', handle: { $ne: null, $ne: '' } },
            { name: 1, handle: 1, bio: 1, photo: 1, isLive: 1, inSession: 1, _id: 0 }
        ).sort({ isLive: -1, createdAt: -1 });
        res.json({ creators });
    } catch (err) {
        console.error('All creators error:', err);
        res.status(500).json({ error: 'Could not fetch creators.' });
    }
});

app.get('/creator/:handle', async (req, res) => {
    try {
        // Handle format is name@truthordare — normalise by stripping leading @ if present
        const handle = req.params.handle.replace(/^@/, '');
        const creator = await User.findOne({ handle, role: 'creator' }).select('name bio photo extraPhotos isLive inSession handle stripeAccountId socials');
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        res.json({ creator });
    } catch (err) {
        console.error('Failed to fetch creator profile:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

// ── END BOOKING ENDPOINTS ──────────────────────────────────────────────────────

// POST /notify-creator — fan sends a notification to a creator
app.post('/notify-creator', async (req, res) => {
    const { creatorHandle, fanName, fanEmail } = req.body;
    if (!creatorHandle || !fanName || !fanEmail) return res.status(400).json({ error: 'Missing fields.' });
    try {
        const handle = creatorHandle.replace(/^@/, '');
        const creator = await User.findOne({ handle, role: 'creator' });
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        console.log(`🔔 Fan notification: ${fanName} (${fanEmail}) is interested in booking ${creator.name}`);
        const prefs = creator.notificationPrefs || {};
        const wantsEmail = prefs.email !== false; // default true
        const wantsSms = !!prefs.sms;
        const customHandle = prefs.customHandle || null;
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

        // Build notification methods summary for the email
        const notifyMethods = [];
        if (wantsEmail) notifyMethods.push('Email');
        if (wantsSms && prefs.phone) notifyMethods.push(`SMS (${prefs.phone})`);
        if (customHandle) notifyMethods.push(customHandle);

        // 1. Send email notification if creator wants email
        if (wantsEmail) {
            const notifyHtml = `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                    <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">🔔 A fan is interested in booking you!</h2>
                    <p style="font-size:15px;margin-bottom:16px;"><strong style="color:#FDF6EC;">${fanName}</strong> wants to book a session with you but isn't ready to pay yet.</p>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan name</td><td style="padding:8px 0;color:#FDF6EC;font-weight:700;">${fanName}</td></tr>
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan email</td><td style="padding:8px 0;color:#FDF6EC;">${fanEmail}</td></tr>
                    </table>
                    ${customHandle ? `<p style="font-size:14px;color:#FDF6EC;margin-bottom:12px;">You also asked to be contacted via: <strong>${customHandle}</strong></p>` : ''}
                    <p style="font-size:13px;color:#9A8A72;">Reply directly to this email to reach out, or share your profile: <a href="${frontendUrl}/creator/${creator.handle}" style="color:#D4A574;">${frontendUrl}/creator/${creator.handle}</a></p>
                </div>`;
            await sendEmail(creator.email, `🔔 ${fanName} is interested in booking a session with you`, notifyHtml);
        }

        // 2. Return the creator's custom handle to the fan (so they know how to reach the creator)
        res.json({ success: true, notifyMethods, customHandle });
    } catch (err) {
        console.error('Notify creator failed:', err);
        res.status(500).json({ error: 'Could not send notification.' });
    }
});

// ── DELETE ACCOUNT ──────────────────────────────────────────────────────────
// Requires auth. Creator or fan can delete their own account.
// Creators: also removes their Featured entry and marks Stripe account as deleted.
app.delete('/account', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'Account not found.' });

        // If creator, remove from Featured collection too
        if (user.role === 'creator') {
            await Featured.deleteMany({ email: user.email });
            // Optionally deauthorize Stripe Express account
            if (user.stripeAccountId) {
                try {
                    await stripe.accounts.del(user.stripeAccountId);
                } catch (stripeErr) {
                    console.warn('Stripe account deletion skipped:', stripeErr.message);
                }
            }
        }

        await User.findByIdAndDelete(req.user.userId);
        res.json({ success: true, message: 'Account deleted successfully.' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Could not delete account.' });
    }
});

// POST /forgot-password — send reset link to email
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        // Always return success to avoid email enumeration
        if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });
        const token = crypto.randomBytes(32).toString('hex');
        user.resetToken = token;
        user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();
        const resetUrl = `${FRONTEND}/reset-password?token=${token}`;
        await sendEmail(user.email, 'Reset your Truth or Dare password', `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#1a0000;color:#FDF6EC;border-radius:10px;">
                <h2 style="color:#D4A574;font-size:24px;margin-bottom:8px;">Reset Your Password</h2>
                <p style="color:#C9B99A;margin-bottom:24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
                <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#CC0000;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">Reset Password</a>
                <p style="color:#9A8A72;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
        `);
        res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (err) { res.status(500).json({ error: 'Could not process request.' }); }
});

// POST /reset-password — set new password using token
app.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
        const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
        if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        user.passwordHash = await bcrypt.hash(password, 10);
        user.resetToken = null;
        user.resetTokenExpiry = null;
        await user.save();
        res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch (err) { res.status(500).json({ error: 'Could not reset password.' }); }
});

// ── ADMIN ENDPOINTS ──────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'Gentssolo55%';

// GET /admin/stats — platform overview
app.get('/admin/stats', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const totalCreators = await User.countDocuments({ role: 'creator' });
        const liveCreators = await User.countDocuments({ role: 'creator', isLive: true });
        const totalBookings = await Booking.countDocuments();
        const pendingBookings = await Booking.countDocuments({ status: 'pending' });
        const paidBookings = await Booking.countDocuments({ status: 'paid' });
        const declinedBookings = await Booking.countDocuments({ status: 'declined' });
        const PRICES = { truth: 1500, dare: 4500 };
        const paidSessions = await Booking.find({ status: 'paid' });
        const totalRevenue = paidSessions.reduce((sum, b) => sum + (PRICES[b.sessionType] || 0), 0);
        const platformCut = Math.round(totalRevenue * 0.15);
        res.json({ totalCreators, liveCreators, totalBookings, pendingBookings, paidBookings, declinedBookings, totalRevenueUSD: (totalRevenue/100).toFixed(2), platformCutUSD: (platformCut/100).toFixed(2) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/creators — list all creators
app.get('/admin/creators', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const creators = await User.find({ role: 'creator' }).select('name email handle bio photo isLive inSession stripeAccountId featuredRequested createdAt').sort({ createdAt: -1 });
        res.json({ creators });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/bookings — list all bookings
app.get('/admin/bookings', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const bookings = await Booking.find().sort({ createdAt: -1 }).limit(100);
        res.json({ bookings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /admin/creator/:id — remove a creator
app.delete('/admin/creator/:id', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ error: 'Not found' });
        await Featured.deleteMany({ email: user.email });
        res.json({ success: true, deleted: user.name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /admin/booking/:id/status — reset booking status (admin only)
app.put('/admin/booking/:id/status', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { status, token } = req.body;
        const update = { status };
        if (token !== undefined) update.token = token;
        const booking = await Booking.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        res.json({ success: true, booking: { _id: booking._id, status: booking.status, token: booking.token } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /admin/booking/:id — remove a booking
app.delete('/admin/booking/:id', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const booking = await Booking.findByIdAndDelete(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        res.json({ success: true, deleted: booking._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /admin/creator/:id/feature — approve or remove from featured
app.put('/admin/creator/:id/feature', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { approve } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'Not found' });
        if (approve) {
            user.featuredRequested = true;
            await user.save();
            const existing = await Featured.findOne({ email: user.email });
            if (existing) { existing.approved = true; await existing.save(); }
            else { await Featured.create({ name: user.name, email: user.email, bio: user.bio || '', photo: user.photo || null, approved: true }); }
        } else {
            user.featuredRequested = false;
            await user.save();
            await Featured.deleteMany({ email: user.email });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: fix all handles to name@truthordare format
app.post('/admin/fix-handles', async (req, res) => {
    const { secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const creators = await User.find({ role: 'creator', handle: { $ne: null } });
        let fixed = [];
        for (const c of creators) {
            let h = c.handle.replace(/^@+/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            const newHandle = h ? `${h}@truthordare` : null;
            if (newHandle !== c.handle) {
                fixed.push({ old: c.handle, new: newHandle, name: c.name });
                c.handle = newHandle;
                await c.save();
            }
        }
        res.json({ success: true, fixed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update any creator profile by handle
app.post('/admin/update-creator', async (req, res) => {
    const { secret, handle, updates } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const creator = await User.findOneAndUpdate(
            { handle },
            { $set: updates },
            { new: true }
        );
        if (!creator) return res.status(404).json({ error: 'Creator not found' });
        res.json({ success: true, creator: { name: creator.name, handle: creator.handle, bio: creator.bio } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete a creator by name
app.post('/admin/delete-creator', async (req, res) => {
    const { secret, name } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const result = await User.findOneAndDelete({ name, role: 'creator' });
        if (!result) return res.status(404).json({ error: 'Creator not found' });
        res.json({ success: true, deleted: result.name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: reset any user's password by email
app.post('/admin/reset-password', async (req, res) => {
    const { secret, email, newPassword } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword required' });
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        const result = await User.findOneAndUpdate({ email }, { $set: { passwordHash: hash } }, { new: true });
        if (!result) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, message: `Password reset for ${result.name} (${result.email})` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete any user by email
app.post('/admin/delete-user', async (req, res) => {
    const { secret, email } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
        const result = await User.findOneAndDelete({ email: email.toLowerCase() });
        if (!result) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, deleted: result.name, email: result.email, role: result.role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: force-set user role bypassing Mongoose schema validation
app.post('/admin/fix-role', async (req, res) => {
    const { secret, email, role } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    if (!email || !role) return res.status(400).json({ error: 'email and role required' });
    try {
        const result = await mongoose.connection.db.collection('users').findOneAndUpdate(
            { email: email.toLowerCase() },
            { $set: { role } },
            { returnDocument: 'after' }
        );
        const user = result.value || result;
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, name: user.name, email: user.email, role: user.role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/booking/:id/fulfill — manually trigger post-payment fulfillment (generate PIN, create room, send emails)
app.post('/admin/booking/:id/fulfill', async (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';
        const sessionType = booking.sessionType;
        const sessionLabel = sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';
        const fanName = booking.fanName;
        const fanEmail = booking.fanEmail;
        const bookingDate = booking.fanChosenDate || booking.proposedDate || booking.requestedDate || '';
        const bookingTime = booking.fanChosenTime || booking.proposedTime || booking.requestedTime || '';
        // Find creator
        const creator = await User.findOne({ email: booking.creatorEmail });
        const creatorName = creator ? creator.name : booking.creatorName;
        const creatorEmail = booking.creatorEmail;
        const creatorHandle = creator ? creator.handle : '';
        // Generate PIN
        const sessionPin = String(Math.floor(1000 + Math.random() * 9000));
        // Create Daily.co room
        let roomUrl = null;
        let roomId = null;
        if (process.env.DAILY_API_KEY) {
            try {
                const room = await createDailyRoom(sessionType);
                roomUrl = room.url;
                roomId = room.name;
            } catch (e) { console.error('Daily room error:', e.message); }
        }
        const roomLink = roomUrl
            ? `${frontendUrl}/room.html?id=${roomId}&creator=${encodeURIComponent(creatorHandle)}&type=${sessionType}&pin=${sessionPin}&booking=${booking._id}`
            : null;
        const fanRoomLink = roomUrl && booking.token
            ? `${frontendUrl}/room.html?booking=${booking._id}&token=${encodeURIComponent(booking.token)}`
            : roomLink;
        // Update booking
        booking.sessionPin = sessionPin;
        if (roomId) booking.roomId = roomId;
        if (roomUrl) booking.roomUrl = roomUrl;
        booking.status = 'paid';
        await booking.save();
        // Send email to creator
        if (creatorEmail) {
            const creatorPayout = sessionType === 'truth' ? 1275 : 3825;
            const creatorHtml = emailTemplate({
                title: `💰 Payment Received!`,
                preheader: `${fanName} paid for a ${sessionLabel} — session confirmed`,
                bodyHtml: `<p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;"><strong style="color:#FDF6EC;">${fanName}</strong> has paid for a <strong style="color:#D4A574;">${sessionLabel}</strong>. Your payout: <strong style="color:#22c55e;">$${(creatorPayout/100).toFixed(2)}</strong></p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;"><tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Fan</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${fanName}</td></tr><tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr><tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Time</td><td style="padding:9px 0;color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr></table><div style="margin:20px 0;padding:16px;background:rgba(212,165,116,0.1);border:2px solid #D4A574;border-radius:10px;text-align:center;"><p style="margin:0 0 6px 0;font-size:12px;color:#9A8A72;letter-spacing:1px;text-transform:uppercase;">Session PIN</p><p style="margin:0;font-size:36px;font-weight:900;color:#D4A574;letter-spacing:8px;">${sessionPin}</p></div>`,
                ctaUrl: roomLink || `${frontendUrl}/creator-dashboard.html`,
                ctaText: roomLink ? '▶ Start Session Now' : '📊 Go to Dashboard',
                footerNote: 'Log into your creator dashboard to manage this booking.'
            });
            await sendEmail(creatorEmail, `💰 ${fanName} paid for ${sessionLabel} — session confirmed`, creatorHtml);
        }
        // Send email to fan
        if (fanEmail) {
            const fanHtml = emailTemplate({
                title: '✅ You\'re All Set!',
                preheader: `Your ${sessionLabel} with ${creatorName} is confirmed and paid`,
                bodyHtml: `<p style="font-size:15px;color:#C9B99A;margin:0 0 20px 0;">Your <strong style="color:#FDF6EC;">${sessionLabel}</strong> with <strong style="color:#FDF6EC;">${creatorName}</strong> is booked and paid!</p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;"><tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;width:40%;">Session</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#D4A574;font-weight:700;">${sessionLabel}</td></tr><tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Creator</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${creatorName}</td></tr><tr><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#9A8A72;font-size:13px;">Date</td><td style="padding:9px 0;border-bottom:1px solid rgba(212,165,116,0.1);color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr><tr><td style="padding:9px 0;color:#9A8A72;font-size:13px;">Time</td><td style="padding:9px 0;color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr></table><div style="margin:20px 0;padding:16px;background:rgba(212,165,116,0.1);border:2px solid #D4A574;border-radius:10px;text-align:center;"><p style="margin:0 0 6px 0;font-size:12px;color:#9A8A72;letter-spacing:1px;text-transform:uppercase;">Your Session PIN</p><p style="margin:0;font-size:36px;font-weight:900;color:#D4A574;letter-spacing:8px;">${sessionPin}</p><p style="margin:6px 0 0 0;font-size:12px;color:#9A8A72;">Enter this PIN when joining the session room.</p></div>`,
                ctaUrl: fanRoomLink || `${frontendUrl}/fan-dashboard.html`,
                ctaText: fanRoomLink ? '▶ Join Your Session' : '📊 Go to Your Dashboard',
                footerNote: 'Questions? Visit truthordareformyfans.com'
            });
            await sendEmail(fanEmail, `✅ Your ${sessionLabel} with ${creatorName} is confirmed`, fanHtml);
        }
        res.json({ success: true, sessionPin, roomUrl, roomId, message: 'Fulfillment complete — emails sent' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.send('truthordareformyfans.com backend ✓'));

app.listen(PORT, () => {
    console.log(`\n🎯 Server running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
    console.log(`   Split: 85% creator / 15% platform\n`);
});
