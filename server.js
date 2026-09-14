require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const express = require('express');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Database Pool Configuration
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

// User Creation State Tracker
const userState = {};

// Safe HTML String Escaper (Prevents Telegram HTML Parser Errors)
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Global Error Catching (Prevents Bot Crashes)
bot.catch((err, ctx) => {
    console.error(`❌ Bot Error for ${ctx.updateType}:`, err);
});

// Database Initialization
async function initDB() {
    try {
        const connection = await db.getConnection();
        
        await connection.query(`
            CREATE TABLE IF NOT EXISTS products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                quantity INT NOT NULL,
                description TEXT,
                photo_id VARCHAR(255),
                status ENUM('available', 'out_of_stock') DEFAULT 'available',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                user_name VARCHAR(255),
                product_id INT NOT NULL,
                quantity INT DEFAULT 1,
                total_price DECIMAL(10,2) NOT NULL,
                status ENUM('pending', 'sold', 'cancelled') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS cart (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                product_id INT NOT NULL,
                quantity INT DEFAULT 1,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
        `);

        connection.release();
        console.log("✅ Database Tables Ready!");
    } catch (err) {
        console.error("❌ Database Init Error:", err);
    }
}
initDB();

// User Role Verification
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const EMPLOYEE_IDS = (process.env.EMPLOYEE_IDS || "").split(',').map(id => id.trim());

function getRole(userId) {
    if (String(userId) === String(ADMIN_ID)) return 'ADMIN';
    if (EMPLOYEE_IDS.includes(String(userId))) return 'EMPLOYEE';
    return 'USER';
}

// Clean Main Menu Keyboards
function getMainMenu(userId) {
    const role = getRole(userId);
    
    if (role === 'ADMIN') {
        return Markup.keyboard([
            ['🛍️ ምርቶችና ሱቅ', '➕ አዲስ እቃ ጨምር'],
            ['⏳ የደንበኞች ትዕዛዝ', '📊 የሽያጭ ሪፖርት'],
            ['📞 አድራሻና መረጃ']
        ]).resize();
    } else if (role === 'EMPLOYEE') {
        return Markup.keyboard([
            ['🛍️ ምርቶችና ሱቅ', '⏳ የደንበኞች ትዕዛዝ'],
            ['📞 አድራሻና መረጃ']
        ]).resize();
    } else {
        return Markup.keyboard([
            ['🛍️ ምርቶችና ሱቅ', '🛒 የእኔ ካርት'],
            ['📦 የእኔ ትዕዛዞች', '📞 አድራሻና መረጃ']
        ]).resize();
    }
}

// State Reset Middleware: Reset input wizards whenever a menu button is clicked
const menuButtons = [
    '🛍️ ምርቶችና ሱቅ', '🛒 የእኔ ካርት', '📦 የእኔ ትዕዛዞች', 
    '⏳ የደንበኞች ትዕዛዝ', '📊 የሽያጭ ሪፖርት', '📞 አድራሻና መረጃ', '➕ አዲስ እቃ ጨምር'
];

bot.use((ctx, next) => {
    if (ctx.message && ctx.message.text && menuButtons.includes(ctx.message.text)) {
        delete userState[ctx.from?.id];
    }
    return next();
});

// 1. Start Command
bot.start(async (ctx) => {
    delete userState[ctx.from.id];
    const role = getRole(ctx.from.id);
    let msg = `✨ <b>ሰላም ${escapeHTML(ctx.from.first_name)}!</b>\nእንኳን ወደ ኦፊሴላዊ የቴሌግራም ሱቃችን በደህና መጡ።`;

    if (role === 'ADMIN') msg += `\n\n🔑 <b>የገቡበት አካውንት፦</b> አድሚን (Admin)`;
    else if (role === 'EMPLOYEE') msg += `\n\nስማርት አካውንት፦ <b>ሰራተኛ (Employee)</b>`;

    await ctx.replyWithHTML(msg, getMainMenu(ctx.from.id));
});

// 2. Product Catalog View
bot.hears('🛍️ ምርቶችና ሱቅ', async (ctx) => {
    try {
        const [products] = await db.query(`SELECT * FROM products WHERE status = 'available' AND quantity > 0 ORDER BY id DESC`);
        
        if (products.length === 0) {
            return ctx.replyWithHTML("📦 <b>በአሁኑ ሰዓት ምንም የሚሸጥ እቃ አልተመዘገበም።</b>");
        }

        for (const item of products) {
            const caption = 
                `🏷️ <b>${escapeHTML(item.name)}</b>\n\n` +
                `💰 <b>ዋጋ፦</b> ${item.price} ብር\n` +
                `📦 <b>የቀረ ብዛት፦</b> ${item.quantity}\n` +
                `📝 <b>መግለጫ፦</b> ${escapeHTML(item.description || 'ምንም መግለጫ አልተካተተም')}`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('🛒 ወደ ካርት ጨምር', `cart_add_${item.id}`)]
            ]);

            if (item.photo_id) {
                await ctx.replyWithPhoto(item.photo_id, { caption, parse_mode: 'HTML', ...buttons });
            } else {
                await ctx.replyWithHTML(caption, buttons);
            }
        }
    } catch (err) {
        console.error("Products View Error:", err);
        ctx.replyWithHTML("❌ እቃዎችን ማውጣት አልተቻለም።");
    }
});

// Add to Cart Action
bot.action(/cart_add_(\d+)/, async (ctx) => {
    const productId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        await db.query(`INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, 1)`, [userId, productId]);
        await ctx.answerCbQuery("✅ እቃው በስኬት ወደ ካርትዎ ተጨምሯል!");
    } catch (err) {
        console.error("Cart Error:", err);
        await ctx.answerCbQuery("❌ ወደ ካርት መጨመር አልተቻለም");
    }
});

// 3. User Cart
bot.hears('🛒 የእኔ ካርት', async (ctx) => {
    const userId = ctx.from.id;
    try {
        const [items] = await db.query(`
            SELECT c.id as cart_id, p.name, p.price 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [userId]);

        if (items.length === 0) {
            return ctx.replyWithHTML("🛒 <b>ካርትዎ ባዶ ነው።</b>\nእቃዎችን ለመምረጥ '🛍️ ምርቶችና ሱቅ' የሚለውን ይጫኑ።");
        }

        let msg = "🛒 <b>በካርትዎ ውስጥ ያሉ እቃዎች፦</b>\n\n";
        let total = 0;
        items.forEach((item, index) => {
            msg += `<b>${index + 1}.</b> ${escapeHTML(item.name)} — <b>${item.price} ብር</b>\n`;
            total += parseFloat(item.price);
        });
        msg += `\n───────────────\n💵 <b>ጠቅላላ የሚከፈለው፦</b> <code>${total.toFixed(2)} ብር</code>`;

        const buttons = Markup.inlineKeyboard([
            [Markup.button.callback('✅ ትዕዛዙን አረጋግጥ (Checkout)', 'do_checkout')],
            [Markup.button.callback('🗑️ ካርቱን አፅዳ', 'do_clear_cart')]
        ]);

        await ctx.replyWithHTML(msg, buttons);
    } catch (err) {
        console.error("Cart Display Error:", err);
    }
});

// Checkout Action
bot.action('do_checkout', async (ctx) => {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || "Guest";

    try {
        const [cartItems] = await db.query(`
            SELECT c.product_id, p.price 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [userId]);

        if (cartItems.length === 0) {
            return ctx.answerCbQuery("ካርትዎ ባዶ ነው!");
        }

        for (const item of cartItems) {
            await db.query(
                `INSERT INTO orders (user_id, user_name, product_id, total_price, status) VALUES (?, ?, ?, ?, 'pending')`,
                [userId, userName, item.product_id, item.price]
            );
        }

        await db.query(`DELETE FROM cart WHERE user_id = ?`, [userId]);
        await ctx.answerCbQuery();
        await ctx.replyWithHTML("🎉 <b>ትዕዛዝዎ በስኬት ተልኳል!</b>\nሰራተኞቻችን በቅርቡ አረጋግጠው ያነጋግሩዎታል።");
    } catch (err) {
        console.error("Checkout Error:", err);
    }
});

// Clear Cart Action
bot.action('do_clear_cart', async (ctx) => {
    try {
        await db.query(`DELETE FROM cart WHERE user_id = ?`, [ctx.from.id]);
        await ctx.answerCbQuery("ካርቱ ጸድቷል!");
        await ctx.replyWithHTML("🗑️ <b>ካርትዎ ተጠርጓል።</b>");
    } catch (err) {
        console.error(err);
    }
});

// 4. User My Orders View
bot.hears('📦 የእኔ ትዕዛዞች', async (ctx) => {
    try {
        const [orders] = await db.query(`
            SELECT p.name, o.total_price, o.status, o.created_at 
            FROM orders o 
            JOIN products p ON o.product_id = p.id 
            WHERE o.user_id = ? 
            ORDER BY o.id DESC LIMIT 10
        `, [ctx.from.id]);

        if (orders.length === 0) {
            return ctx.replyWithHTML("📦 <b>ምንም ያዘዙት ትዕዛዝ የለም።</b>");
        }

        let msg = "📦 <b>የእርስዎ የቅርብ ትዕዛዞች፦</b>\n\n";
        orders.forEach((o, index) => {
            const statusTag = o.status === 'pending' ? '⏳ በመጠበቅ ላይ (Pending)' : o.status === 'sold' ? '✅ ተጠናቋል (Sold)' : '❌ የተሰረዘ';
            msg += `<b>${index + 1}. ${escapeHTML(o.name)}</b>\n💰 ዋጋ፦ ${o.total_price} ብር\nሁኔታ፦ ${statusTag}\n\n`;
        });

        await ctx.replyWithHTML(msg);
    } catch (err) {
        console.error("Orders View Error:", err);
    }
});

// 5. Admin & Employee: Pending Orders Management
bot.hears('⏳ የደንበኞች ትዕዛዝ', async (ctx) => {
    const role = getRole(ctx.from.id);
    if (role === 'USER') return;

    try {
        const [orders] = await db.query(`
            SELECT o.id, o.user_name, o.total_price, p.name as product_name, o.product_id 
            FROM orders o 
            JOIN products p ON o.product_id = p.id 
            WHERE o.status = 'pending' 
            ORDER BY o.id ASC
        `);

        if (orders.length === 0) {
            return ctx.replyWithHTML("✅ <b>ምንም የሚጠበቅ (Pending) ትዕዛዝ የለም።</b>");
        }

        for (const order of orders) {
            const msg = 
                `📌 <b>ትዕዛዝ #${order.id}</b>\n` +
                `👤 <b>ደንበኛ፦</b> ${escapeHTML(order.user_name)}\n` +
                `🛍️ <b>እቃ፦</b> ${escapeHTML(order.product_name)}\n` +
                `💰 <b>ዋጋ፦</b> ${order.total_price} ብር`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('✅ ሸጥኩት (Mark as Sold)', `sell_${order.id}_${order.product_id}`)]
            ]);

            await ctx.replyWithHTML(msg, buttons);
        }
    } catch (err) {
        console.error("Pending Orders Error:", err);
    }
});

// Mark Order as Sold & Reduce Stock
bot.action(/sell_(\d+)_(\d+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const productId = ctx.match[2];

    try {
        await db.query(`UPDATE orders SET status = 'sold' WHERE id = ?`, [orderId]);
        await db.query(`UPDATE products SET quantity = quantity - 1 WHERE id = ?`, [productId]);

        const [[prod]] = await db.query(`SELECT quantity FROM products WHERE id = ?`, [productId]);
        if (prod && prod.quantity <= 0) {
            await db.query(`UPDATE products SET status = 'out_of_stock' WHERE id = ?`, [productId]);
        }

        await ctx.answerCbQuery("✅ ትዕዛዙ ተሸጧል!");
        await ctx.editMessageText(`✅ <b>ትዕዛዝ #${orderId} በስኬት ተሸጧል (Sold)!</b>\nየእቃው ስቶክ በ -1 ቀንሷል።`, { parse_mode: 'HTML' });
    } catch (err) {
        console.error("Sell Action Error:", err);
    }
});

// 6. Admin Sales Report
bot.hears('📊 የሽያጭ ሪፖርት', async (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') return;

    try {
        const [[soldData]] = await db.query(`SELECT COUNT(*) as total_count, SUM(total_price) as total_sum FROM orders WHERE status = 'sold'`);
        const [[pendingData]] = await db.query(`SELECT COUNT(*) as pending_count FROM orders WHERE status = 'pending'`);
        const [[prodData]] = await db.query(`SELECT COUNT(*) as total_prods FROM products WHERE status = 'available' AND quantity > 0`);

        const report = 
            `📊 <b>የሱቁ አጠቃላይ የሽያጭ ሪፖርት</b>\n\n` +
            `✅ <b>የተሸጡ እቃዎች ብዛት፦</b> <code>${soldData.total_count || 0}</code>\n` +
            `💰 <b>ጠቅላላ የተሰበሰበ ገቢ፦</b> <code>${soldData.total_sum || 0} ብር</code>\n` +
            `⏳ <b>በሂደት ላይ ያሉ (Pending)፦</b> <code>${pendingData.pending_count || 0}</code>\n` +
            `📦 <b>በሱቅ ውስጥ ያሉ እቃዎች፦</b> <code>${prodData.total_prods || 0}</code>`;

        await ctx.replyWithHTML(report);
    } catch (err) {
        console.error("Report Error:", err);
    }
});

// 7. Contact Information
bot.hears('📞 አድራሻና መረጃ', (ctx) => {
    const contactInfo = 
        `🏢 <b>የሱቃችን አድራሻና የመገናኛ መስመር፦</b>\n\n` +
        `📍 <b>ቦታ፦</b> አዲስ አበባ፣ ኢትዮጵያ\n` +
        `📞 <b>ስልክ፦</b> +251 900 000 000\n` +
        `💬 <b>የቴሌግራም አድሚን፦</b> @YourAdminUsername\n\n` +
        `⏱️ <b>የስራ ሰዓት፦</b> ከሰኞ - ቅዳሜ (ከ2:00 አባት እስከ 2:00 ምሽት)`;

    ctx.replyWithHTML(contactInfo);
});

// 8. Admin Add Product Flow Wizard
bot.hears('➕ አዲስ እቃ ጨምር', (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') {
        return ctx.replyWithHTML("❌ <b>ይህን ለማድረግ የአድሚን ስልጣን የለዎትም።</b>");
    }

    userState[ctx.from.id] = { step: 'WAIT_PHOTO', data: {} };
    ctx.replyWithHTML(
        "📸 <b>እባክዎን የእቃውን ፎቶ ይላኩ፦</b>\n\n<i>(ሂደቱን ለማቋረጥ ' /cancel ' ብለው መፃፍ ይችላሉ)</i>"
    );
});

// Cancel Wizard
bot.command('cancel', (ctx) => {
    delete userState[ctx.from.id];
    ctx.replyWithHTML("❌ <b>እቃ የመመዝገቡ ሂደት ተሰርዟል።</b>", getMainMenu(ctx.from.id));
});

// Handle Photo Upload Step
bot.on('photo', async (ctx) => {
    const state = userState[ctx.from.id];
    if (state && state.step === 'WAIT_PHOTO') {
        state.data.photo_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        state.step = 'WAIT_NAME';
        await ctx.replyWithHTML("📝 <b>በጣም ጥሩ! አሁን የእቃውን ስም ያስገቡ፦</b>");
    }
});

// Handle Text Inputs for Product Creation Step
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const state = userState[userId];

    if (!state) return next();

    if (state.step === 'WAIT_NAME') {
        state.data.name = text;
        state.step = 'WAIT_PRICE';
        await ctx.replyWithHTML("💰 <b>የእቃውን ዋጋ በብር ያስገቡ (ምሳሌ፦ 1800)፦</b>");
    } else if (state.step === 'WAIT_PRICE') {
        const price = parseFloat(text);
        if (isNaN(price)) {
            return ctx.replyWithHTML("⚠️ <b>እባክዎን ትክክለኛ የቁጥር ዋጋ ያስገቡ፦</b>");
        }
        state.data.price = price;
        state.step = 'WAIT_QTY';
        await ctx.replyWithHTML("🔢 <b>የእቃውን ብዛት (Quantity) ያስገቡ (ምሳሌ፦ 5)፦</b>");
    } else if (state.step === 'WAIT_QTY') {
        const qty = parseInt(text);
        if (isNaN(qty)) {
            return ctx.replyWithHTML("⚠️ <b>እባክዎን ትክክለኛ ቁጥር ያስገቡ፦</b>");
        }
        state.data.quantity = qty;
        state.step = 'WAIT_DESC';
        await ctx.replyWithHTML("ℹ️ <b>የእቃውን ማብራሪያ (Description) ያስገቡ፦</b>");
    } else if (state.step === 'WAIT_DESC') {
        state.data.description = text;

        try {
            await db.query(
                `INSERT INTO products (name, price, quantity, description, photo_id) VALUES (?, ?, ?, ?, ?)`,
                [state.data.name, state.data.price, state.data.quantity, state.data.description, state.data.photo_id]
            );
            await ctx.replyWithHTML("🎉 <b>እቃው በስኬት ተመዝግቧል! አሁን በሱቁ ውስጥ ይታያል።</b>", getMainMenu(userId));
        } catch (err) {
            console.error("Save Product Error:", err);
            await ctx.replyWithHTML("❌ እቃውን መመዝገብ አልተቻለም።");
        }
        delete userState[userId];
    } else {
        return next();
    }
});

// Express Web Server Port Binding for Render
app.get('/', (req, res) => res.send('Store Bot Service Active 24/7'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Launch Telegraf Bot
bot.launch();