require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const express = require('express');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

const userState = {};
const menuButtons = ['🛍️ ምርቶችን ይመልከቱ', '🛒 የኔ ካርት', '📦 የኔ ትዕዛዞች', '⏳ Pending ትዕዛዞች', '📊 የሽያጭ ሪፖርት', '📞 አድራሻ እና ግንኙነት', '➕ አዲስ እቃ ጨምር'];

// 1. መፍትሄ፦ ማንኛውንም በተን ሲነካ የነበረበትን ፕሮሰስ ያቋርጣል (Cancel State)
bot.use((ctx, next) => {
    if (ctx.message && ctx.message.text && menuButtons.includes(ctx.message.text)) {
        delete userState[ctx.from?.id]; // Cancel any ongoing adding process
    }
    return next();
});

// Database Init
async function initDB() {
    try {
        const connection = await db.getConnection();
        await connection.query(`CREATE TABLE IF NOT EXISTS products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, price DECIMAL(10,2) NOT NULL, quantity INT NOT NULL, description TEXT, photo_id VARCHAR(255), status ENUM('available', 'out_of_stock') DEFAULT 'available', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await connection.query(`CREATE TABLE IF NOT EXISTS orders (id INT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, user_name VARCHAR(255), product_id INT NOT NULL, quantity INT DEFAULT 1, total_price DECIMAL(10,2) NOT NULL, status ENUM('pending', 'sold', 'cancelled') DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE)`);
        await connection.query(`CREATE TABLE IF NOT EXISTS cart (id INT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, product_id INT NOT NULL, quantity INT DEFAULT 1, FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE)`);
        connection.release();
    } catch (err) { console.error(err); }
}
initDB();

const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const EMPLOYEE_IDS = (process.env.EMPLOYEE_IDS || "").split(',');

function getRole(userId) {
    if (String(userId) === String(ADMIN_ID)) return 'ADMIN';
    if (EMPLOYEE_IDS.includes(String(userId))) return 'EMPLOYEE';
    return 'USER';
}

function getMainMenu(userId) {
    const role = getRole(userId);
    if (role === 'ADMIN') return Markup.keyboard([['🛍️ ምርቶችን ይመልከቱ', '➕ አዲስ እቃ ጨምር'], ['⏳ Pending ትዕዛዞች', '📊 የሽያጭ ሪፖርት'], ['📞 አድራሻ እና ግንኙነት']]).resize();
    if (role === 'EMPLOYEE') return Markup.keyboard([['🛍️ ምርቶችን ይመልከቱ', '⏳ Pending ትዕዛዞች'], ['📞 አድራሻ እና ግንኙነት']]).resize();
    return Markup.keyboard([['🛍️ ምርቶችን ይመልከቱ', '🛒 የኔ ካርት'], ['📦 የኔ ትዕዛዞች', '📞 አድራሻ እና ግንኙነት']]).resize();
}

bot.start((ctx) => {
    ctx.reply(`ሰላም ${ctx.from.first_name}! እንኳን በደህና መጡ።`, getMainMenu(ctx.from.id));
});

// -- ከተስተካከለው ቅደም ተከተል መሰረት ሁሉም በተኖች እዚህ ይገባሉ -- //

bot.hears('🛍️ ምርቶችን ይመልከቱ', async (ctx) => {
    const [products] = await db.query(`SELECT * FROM products WHERE status = 'available' AND quantity > 0`);
    if (products.length === 0) return ctx.reply("📦 ምንም የሚሸጥ እቃ የለም።");
    for (const item of products) {
        const caption = `📌 **${item.name}**\n💰 ዋጋ፦ ${item.price} ብር\n🔢 የቀረ ብዛት፦ ${item.quantity}\nℹ️ ${item.description}`;
        const btns = [[Markup.button.callback('🛒 ወደ ካርት ጨምር', `add_cart_${item.id}`)]];
        if (item.photo_id) await ctx.replyWithPhoto(item.photo_id, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
        else await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
    }
});

bot.action(/add_cart_(\d+)/, async (ctx) => {
    try {
        await db.query(`INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, 1)`, [ctx.from.id, ctx.match[1]]);
        await ctx.answerCbQuery("✅ ወደ ካርት ተጨምሯል!");
    } catch (err) { ctx.answerCbQuery("❌ አልተሳካም"); }
});

bot.hears('🛒 የኔ ካርት', async (ctx) => {
    const [items] = await db.query(`SELECT c.id, p.name, p.price FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [ctx.from.id]);
    if (items.length === 0) return ctx.reply("🛒 ካርትዎ ባዶ ነው።");
    let msg = "🛒 **የመረጧቸው እቃዎች፦**\n\n", total = 0;
    items.forEach((item, i) => { msg += `${i + 1}. ${item.name} - ${item.price} ብር\n`; total += parseFloat(item.price); });
    msg += `\n💵 **ጠቅላላ፦** ${total} ብር`;
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ አሁን እዘዝ (Checkout)', 'checkout')]]) });
});

bot.action('checkout', async (ctx) => {
    try {
        const [items] = await db.query(`SELECT product_id, p.price FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [ctx.from.id]);
        if (items.length === 0) return ctx.answerCbQuery("ካርትዎ ባዶ ነው!");
        for (const item of items) await db.query(`INSERT INTO orders (user_id, user_name, product_id, total_price) VALUES (?, ?, ?, ?)`, [ctx.from.id, ctx.from.first_name, item.product_id, item.price]);
        await db.query(`DELETE FROM cart WHERE user_id = ?`, [ctx.from.id]);
        await ctx.answerCbQuery();
        await ctx.reply("✅ ትዕዛዝዎ ገብቷል! በ 'Pending' ይቆያል።");
    } catch (err) {}
});

bot.hears('📦 የኔ ትዕዛዞች', async (ctx) => {
    const [orders] = await db.query(`SELECT p.name, o.total_price, o.status FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ?`, [ctx.from.id]);
    if (orders.length === 0) return ctx.reply("📦 ምንም ትዕዛዝ የለም።");
    let msg = "📦 **ትዕዛዞችዎ፦**\n\n";
    orders.forEach(o => msg += `▪️ ${o.name} - ${o.total_price} ብር (${o.status === 'pending' ? '⏳ በመጠበቅ ላይ' : '✅ አልቋል'})\n`);
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.hears('⏳ Pending ትዕዛዞች', async (ctx) => {
    if (getRole(ctx.from.id) === 'USER') return;
    const [orders] = await db.query(`SELECT o.id, o.user_name, o.total_price, p.name, o.product_id FROM orders o JOIN products p ON o.product_id = p.id WHERE o.status = 'pending'`);
    if (orders.length === 0) return ctx.reply("✅ የሚጠበቅ ትዕዛዝ የለም።");
    for (const order of orders) {
        await ctx.reply(`📦 **#${order.id}**\n👤 ደበኛ፦ ${order.user_name}\n🛍️ እቃ፦ ${order.name}\n💰 ዋጋ፦ ${order.total_price} ብር`, { 
            parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ ሸጥኩት', `sold_${order.id}_${order.product_id}`)]]) 
        });
    }
});

bot.action(/sold_(\d+)_(\d+)/, async (ctx) => {
    await db.query(`UPDATE orders SET status = 'sold' WHERE id = ?`, [ctx.match[1]]);
    await db.query(`UPDATE products SET quantity = quantity - 1 WHERE id = ?`, [ctx.match[2]]);
    const [[p]] = await db.query(`SELECT quantity FROM products WHERE id = ?`, [ctx.match[2]]);
    if (p.quantity <= 0) await db.query(`UPDATE products SET status = 'out_of_stock' WHERE id = ?`, [ctx.match[2]]);
    await ctx.answerCbQuery("✅ ሸጥኩት!");
    await ctx.editMessageText(`✅ **ትዕዛዝ #${ctx.match[1]} ተሸጧል!**`, { parse_mode: 'Markdown' });
});

bot.hears('📊 የሽያጭ ሪፖርት', async (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') return;
    const [[s]] = await db.query(`SELECT COUNT(*) as c, SUM(total_price) as t FROM orders WHERE status = 'sold'`);
    const [[p]] = await db.query(`SELECT COUNT(*) as c FROM orders WHERE status = 'pending'`);
    ctx.reply(`📊 **ሪፖርት**\n\n✅ የተሸጡ፦ ${s.c || 0}\n💰 ገቢ፦ ${s.t || 0} ብር\n⏳ በመጠበቅ ላይ፦ ${p.c || 0}`, { parse_mode: 'Markdown' });
});

bot.hears('📞 አድራሻ እና ግንኙነት', (ctx) => ctx.reply("📍 አዲስ አበባ\n📞 +251 900 000 000"));

// -- አዲስ እቃ መጨመሪያ ሁሌም በመጨረሻ ይቀመጣል -- //

bot.hears('➕ አዲስ እቃ ጨምር', (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') return;
    userState[ctx.from.id] = { step: 'AWAITING_PHOTO', data: {} };
    ctx.reply("📸 እባክዎን የእቃውን ፎቶ ይላኩ፦");
});

bot.on('photo', async (ctx) => {
    const state = userState[ctx.from.id];
    if (state?.step === 'AWAITING_PHOTO') {
        state.data.photo_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        state.step = 'AWAITING_NAME';
        ctx.reply("📝 አሁን የእቃውን ስም ያስገቡ፦");
    }
});

bot.on('text', async (ctx, next) => {
    const state = userState[ctx.from.id];
    if (!state) return next();
    const text = ctx.message.text;

    if (state.step === 'AWAITING_NAME') { state.data.name = text; state.step = 'AWAITING_PRICE'; ctx.reply("💰 ዋጋ ያስገቡ፦"); }
    else if (state.step === 'AWAITING_PRICE') { state.data.price = parseFloat(text); state.step = 'AWAITING_QTY'; ctx.reply("🔢 ብዛት (Quantity) ያስገቡ፦"); }
    else if (state.step === 'AWAITING_QTY') { state.data.quantity = parseInt(text); state.step = 'AWAITING_DESC'; ctx.reply("ℹ️ ተጨማሪ መግለጫ ያስገቡ፦"); }
    else if (state.step === 'AWAITING_DESC') {
        try {
            await db.query(`INSERT INTO products (name, price, quantity, description, photo_id) VALUES (?, ?, ?, ?, ?)`, [state.data.name, state.data.price, state.data.quantity, text, state.data.photo_id]);
            ctx.reply("✅ እቃው ተጨምሯል!");
        } catch (err) { ctx.reply("❌ ስህተት ተፈጥሯል።"); }
        delete userState[ctx.from.id];
    } else return next();
});

app.get('/', (req, res) => res.send('Running'));
app.listen(process.env.PORT || 3000);
bot.launch();