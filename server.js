require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

// 1. Aiven Cloud MySQL Connection Pool
const pool = mysql.createPool(process.env.DATABASE_URL);

// 2. Auto-Setup Tables on Startup
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(100),
                role VARCHAR(20) DEFAULT 'user',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                price DECIMAL(10,2),
                stock INT DEFAULT 10
            )
        `);
        console.log("✅ Database initialized successfully.");
    } catch (error) {
        console.error("DB Init Error:", error);
    }
}
initDB();

// 3. Main Bot Logic & Smart Routing
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const username = ctx.from.username || ctx.from.first_name;

    // --- ADMIN VIEW ---
    if (userId === ADMIN_ID) {
        return ctx.reply(
            `👨‍💻 እንኳን ደህና መጡ Admin, ${username}!\n\nማድረግ የሚፈልጉትን አማራጭ ይምረጡ፡`,
            Markup.inlineKeyboard([
                [Markup.button.callback('📦 አዲስ እቃ ለመጨመር', 'admin_add_prod')],
                [Markup.button.callback('👥 ተጠቃሚዎችን ለማየት', 'admin_users')],
                [Markup.button.callback('📊 ያሉ እቃዎችን ለማየት', 'admin_inventory')]
            ])
        );
    }

    // --- STANDARD USER VIEW ---
    try {
        await pool.query('INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [userId, username]);
        
        return ctx.reply(
            `👋 ሰላም ${username}!\n\nእንኳን ወደ ሱቃችን በደህና መጡ። ከታች ካሉት አማራጮች መምረጥ ይችላሉ፡`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🛍️ እቃዎችን ማየት (Catalog)', 'user_shop')],
                [Markup.button.callback('👤 የእኔ መረጃ (Profile)', 'user_profile')],
                [Markup.button.callback('📞 እኛን ለማነጋገር', 'user_support')]
            ])
        );
    } catch (error) {
        console.error(error);
        ctx.reply("እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።");
    }
});

// --- USER ACTIONS ---
bot.action('user_shop', async (ctx) => {
    await ctx.answerCbQuery();
    const [products] = await pool.query('SELECT * FROM products WHERE stock > 0');
    
    if (products.length === 0) {
        return ctx.reply("ይቅርታ, አሁን ላይ የሚገኝ እቃ የለም።");
    }

    let buttons = products.map(p => [Markup.button.callback(`🛒 ${p.name} - ${p.price} ብር`, `buy_${p.id}`)]);
    buttons.push([Markup.button.callback('🔙 ወደ ዋናው ምናሌ', 'back_home')]);

    ctx.editMessageText('🛍️ **የእቃዎች ዝርዝር**\n\nለመግዛት የሚፈልጉትን ይጫኑ፡', Markup.inlineKeyboard(buttons));
});

bot.action('user_profile', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const [rows] = await pool.query('SELECT joined_at FROM users WHERE telegram_id = ?', [userId]);
    const joinDate = rows[0] ? new Date(rows[0].joined_at).toLocaleDateString() : 'Unknown';
    
    ctx.editMessageText(`👤 **የእርስዎ መረጃ**\n\nID: ${userId}\nየተመዘገቡበት ቀን: ${joinDate}\nሁኔታ: የተረጋገጠ ተጠቃሚ ✅`, 
        Markup.inlineKeyboard([[Markup.button.callback('🔙 ወደ ዋናው ምናሌ', 'back_home')]])
    );
});

bot.action('user_support', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("📞 የዕርዳታ ማዕከል:\nስልክ: 0911234567\nቴሌግራም: @Support");
});

bot.action('back_home', (ctx) => {
    ctx.answerCbQuery();
    bot.handleUpdate({ message: { text: '/start', chat: ctx.chat, from: ctx.from } });
});

// --- ADMIN ACTIONS ---
bot.action('admin_users', async (ctx) => {
    await ctx.answerCbQuery();
    const [users] = await pool.query('SELECT COUNT(*) as total FROM users');
    ctx.reply(`👥 እስካሁን የተመዘገቡ ተጠቃሚዎች ብዛት: ${users[0].total}`);
});

bot.action('admin_inventory', async (ctx) => {
    await ctx.answerCbQuery();
    const [products] = await pool.query('SELECT * FROM products');
    if (products.length === 0) return ctx.reply("ክምችቱ ባዶ ነው።");
    
    let text = "📦 **የአሁኑ የዕቃ ክምችት:**\n\n";
    products.forEach(p => text += `- ${p.name}: ${p.stock} ቀርቷል (${p.price} ብር)\n`);
    ctx.reply(text);
});
bot.action('admin_add_prod', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        "📝 **አዲስ እቃ ለመጨመር የሚከተለውን ፎርማት ተጠቀም፦**\n\n" +
        "`/add [የእቃው_ስም] [ዋጋ] [ብዛት]`\n\n" +
        "**ምሳሌ፦**\n`/add ጫማ 2800 10`",
        { parse_mode: 'Markdown' }
    );
});

// Admin Command to add product via chat: /add [ስም] [ዋጋ] [ብዛት]
bot.command('add', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const args = ctx.message.text.split(' ');
    if (args.length < 4) return ctx.reply("አጠቃቀም: /add [የእቃው_ስም] [ዋጋ] [ብዛት]\nምሳሌ: /add ጫማ 2800 10");

    const stock = args.pop();
    const price = args.pop();
    const name = args.slice(1).join(' ');

    await pool.query('INSERT INTO products (name, price, stock) VALUES (?, ?, ?)', [name, price, stock]);
    ctx.reply(`✅ እቃው ተመዝግቧል!\n${name} | ${price} ብር | ብዛት: ${stock}`);
});

// 4. Express Server for Free Hosting Keep-Alive
app.get('/', (req, res) => res.send('Telegram Store Bot is Live!'));
app.listen(process.env.PORT || 3000, () => console.log('Web server running.'));

bot.launch().then(() => console.log("🤖 Telegram Bot is Live!"));