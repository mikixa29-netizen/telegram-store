require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const express = require('express');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Database Connection Pool
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

// User Input State Tracker for Admin adding items
const userState = {};

// 1. Database Initialization
async function initDB() {
    try {
        const connection = await db.getConnection();
        
        // Products Table
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

        // Orders Table
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

        // Cart Table
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
        console.log("✅ Database Tables Initialized");
    } catch (err) {
        console.error("❌ DB Init Error:", err);
    }
}
initDB();

// Roles Helper Functions
const ADMIN_ID = process.env.ADMIN_CHAT_ID; // Your Telegram Chat ID
const EMPLOYEE_IDS = (process.env.EMPLOYEE_IDS || "").split(','); // List of Employee Telegram IDs

function getRole(userId) {
    if (String(userId) === String(ADMIN_ID)) return 'ADMIN';
    if (EMPLOYEE_IDS.includes(String(userId))) return 'EMPLOYEE';
    return 'USER';
}

// Main Menu Keyboards based on Role
function getMainMenu(userId) {
    const role = getRole(userId);
    
    if (role === 'ADMIN') {
        return Markup.keyboard([
            ['🛍️ ምርቶችን ይመልከቱ', '➕ አዲስ እቃ ጨምር'],
            ['⏳ Pending ትዕዛዞች', '📊 የሽያጭ ሪፖርት'],
            ['📞 አድራሻ እና ግንኙነት']
        ]).resize();
    } else if (role === 'EMPLOYEE') {
        return Markup.keyboard([
            ['🛍️ ምርቶችን ይመልከቱ', '⏳ Pending ትዕዛዞች'],
            ['📞 አድራሻ እና ግንኙነት']
        ]).resize();
    } else {
        return Markup.keyboard([
            ['🛍️ ምርቶችን ይመልከቱ', '🛒 የኔ ካርት'],
            ['📦 የኔ ትዕዛዞች', '📞 አድራሻ እና ግንኙነት']
        ]).resize();
    }
}

// 2. /start Command
bot.start((ctx) => {
    const role = getRole(ctx.from.id);
    let welcomeMsg = `ሰላም ${ctx.from.first_name}! እንኳን ወደ እቃ መግዣ ቦታችን በደህና መጡ።`;
    
    if (role === 'ADMIN') welcomeMsg += "\n\n🔰 **ስልጣን፦ አድሚን (Admin)**";
    else if (role === 'EMPLOYEE') welcomeMsg += "\n\nመግለጫ፦ **ሰራተኛ (Employee)**";

    ctx.reply(welcomeMsg, getMainMenu(ctx.from.id));
});

// 3. Admin: Add Product Flow
bot.hears('➕ አዲስ እቃ ጨምር', (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') return ctx.reply("❌ ይህን ለማድረግ ስልጣን የለዎትም።");
    
    userState[ctx.from.id] = { step: 'AWAITING_PHOTO', data: {} };
    ctx.reply("📸 እባክዎን የእቃውን ፎቶ ይላኩ፦");
});

// Handle Photo Upload
bot.on('photo', async (ctx) => {
    const state = userState[ctx.from.id];
    if (state && state.step === 'AWAITING_PHOTO') {
        state.data.photo_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        state.step = 'AWAITING_NAME';
        ctx.reply("📝 አሁን የእቃውን ስም ያስገቡ፦");
    }
});

// Handle Text Inputs for Product Creation
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const state = userState[userId];

    if (!state) return next();

    if (state.step === 'AWAITING_NAME') {
        state.data.name = text;
        state.step = 'AWAITING_PRICE';
        ctx.reply("💰 የእቃውን ዋጋ በብር ያስገቡ (ምሳሌ፦ 1500)፦");
    } else if (state.step === 'AWAITING_PRICE') {
        if (isNaN(text)) return ctx.reply("❌ እባክዎን ትክክለኛ ቁጥር ያስገቡ፦");
        state.data.price = parseFloat(text);
        state.step = 'AWAITING_QTY';
        ctx.reply("🔢 የእቃውን ብዛት (Quantity) ያስገቡ፦");
    } else if (state.step === 'AWAITING_QTY') {
        if (isNaN(text)) return ctx.reply("❌ እባክዎን ትክክለኛ ቁጥር ያስገቡ፦");
        state.data.quantity = parseInt(text);
        state.step = 'AWAITING_DESC';
        ctx.reply("ℹ️ የእቃውን ተጨማሪ ማብራሪያ (Description) ያስገቡ፦");
    } else if (state.step === 'AWAITING_DESC') {
        state.data.description = text;
        
        // Save to Database
        try {
            await db.query(
                `INSERT INTO products (name, price, quantity, description, photo_id) VALUES (?, ?, ?, ?, ?)`,
                [state.data.name, state.data.price, state.data.quantity, state.data.description, state.data.photo_id]
            );
            ctx.reply("✅ እቃው በስኬት ወደ ዳታቤዝ ተጨምሯል!", getMainMenu(userId));
        } catch (err) {
            console.error(err);
            ctx.reply("❌ እቃውን መመዝገብ አልተቻለም።");
        }
        delete userState[userId];
    } else {
        return next();
    }
});

// 4. View Products (For All Roles)
bot.hears('🛍️ ምርቶችን ይመልከቱ', async (ctx) => {
    try {
        const [products] = await db.query(`SELECT * FROM products WHERE status = 'available' AND quantity > 0`);
        if (products.length === 0) return ctx.reply("📦 በአሁኑ ሰዓት ምንም የሚሸጥ እቃ የለም።");

        for (const item of products) {
            const caption = `📌 **${item.name}**\n\n💰 **ዋጋ፦** ${item.price} ብር\n🔢 **የቀረ ብዛት፦** ${item.quantity}\nℹ️ **መግለጫ፦** ${item.description}`;
            const buttons = [
                [Markup.button.callback('🛒 ወደ ካርት ጨምር', `add_cart_${item.id}`)]
            ];
            
            if (item.photo_id) {
                await ctx.replyWithPhoto(item.photo_id, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
            } else {
                await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
            }
        }
    } catch (err) {
        console.error(err);
    }
});

// Add to Cart Logic
bot.action(/add_cart_(\d+)/, async (ctx) => {
    const productId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        await db.query(`INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, 1)`, [userId, productId]);
        await ctx.answerCbQuery("✅ እቃው ወደ ካርት ተጨምሯል!");
    } catch (err) {
        console.error(err);
        await ctx.answerCbQuery("❌ ካርት ላይ መጨመር አልተቻለም");
    }
});

// 5. User Cart & Checkout
bot.hears('🛒 የኔ ካርት', async (ctx) => {
    const userId = ctx.from.id;
    try {
        const [items] = await db.query(`
            SELECT c.id as cart_id, p.name, p.price, p.id as product_id 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [userId]);

        if (items.length === 0) return ctx.reply("🛒 ካርትዎ ባዶ ነው።");

        let msg = "🛒 **የመረጧቸው እቃዎች፦**\n\n";
        let total = 0;
        items.forEach((item, index) => {
            msg += `${index + 1}. **${item.name}** - ${item.price} ብር\n`;
            total += parseFloat(item.price);
        });
        msg += `\n💵 **ጠቅላላ ዋጋ፦** ${total} ብር`;

        await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ አሁን እዘዝ (Checkout)', 'checkout')],
                [Markup.button.callback('🗑️ ካርት አፅዳ', 'clear_cart')]
            ])
        });
    } catch (err) {
        console.error(err);
    }
});

// Checkout Action
bot.action('checkout', async (ctx) => {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || "Guest";

    try {
        const [cartItems] = await db.query(`SELECT product_id, p.price FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [userId]);
        if (cartItems.length === 0) return ctx.answerCbQuery("ካርትዎ ባዶ ነው!");

        for (const item of cartItems) {
            await db.query(`INSERT INTO orders (user_id, user_name, product_id, quantity, total_price, status) VALUES (?, ?, ?, 1, ?, 'pending')`, [userId, userName, item.product_id, item.price]);
        }

        await db.query(`DELETE FROM cart WHERE user_id = ?`, [userId]);
        await ctx.answerCbQuery();
        await ctx.reply("✅ ትዕዛዝዎ ገብቷል! ሰራተኞቻችን አይተውት እቃውን እስኪያዘጋጁ ድረስ በ 'Pending' ሁኔታ ይቆያል።");
    } catch (err) {
        console.error(err);
    }
});

// 6. Employee/Admin Workflow: Pending Orders Management
bot.hears('⏳ Pending ትዕዛዞች', async (ctx) => {
    const role = getRole(ctx.from.id);
    if (role !== 'ADMIN' && role !== 'EMPLOYEE') return ctx.reply("❌ ስልጣን የለዎትም።");

    try {
        const [orders] = await db.query(`
            SELECT o.id, o.user_name, o.total_price, p.name as product_name, o.product_id 
            FROM orders o 
            JOIN products p ON o.product_id = p.id 
            WHERE o.status = 'pending'
        `);

        if (orders.length === 0) return ctx.reply("✅ ምንም የሚጠበቅ (Pending) ትዕዛዝ የለም።");

        for (const order of orders) {
            const msg = `📦 **ትዕዛዝ #${order.id}**\n👤 **ደበኛ፦** ${order.user_name}\n🛍️ **እቃ፦** ${order.product_name}\n💰 **ዋጋ፦** ${order.total_price} ብር`;
            const buttons = [
                [Markup.button.callback('✅ ሸጥኩት (Change to Sold)', `mark_sold_${order.id}_${order.product_id}`)]
            ];
            await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        }
    } catch (err) {
        console.error(err);
    }
});

// Change Status to Sold & Reduce Stock
bot.action(/mark_sold_(\d+)_(\d+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const productId = ctx.match[2];

    try {
        // Update Order to Sold
        await db.query(`UPDATE orders SET status = 'sold' WHERE id = ?`, [orderId]);

        // Reduce Product Quantity
        await db.query(`UPDATE products SET quantity = quantity - 1 WHERE id = ?`, [productId]);

        // Check if Out of Stock
        const [[product]] = await db.query(`SELECT quantity FROM products WHERE id = ?`, [productId]);
        if (product.quantity <= 0) {
            await db.query(`UPDATE products SET status = 'out_of_stock' WHERE id = ?`, [productId]);
        }

        await ctx.answerCbQuery("✅ ትዕዛዙ ወደ 'Sold' ተቀይሯል! ስቶክ ቀንሷል።");
        await ctx.editMessageText(`✅ **ትዕዛዝ #${orderId} በስኬት ተሸጧል (Sold)!**`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
    }
});

// 7. Admin Report
bot.hears('📊 የሽያጭ ሪፖርት', async (ctx) => {
    if (getRole(ctx.from.id) !== 'ADMIN') return;

    try {
        const [[soldData]] = await db.query(`SELECT COUNT(*) as count, SUM(total_price) as total FROM orders WHERE status = 'sold'`);
        const [[pendingData]] = await db.query(`SELECT COUNT(*) as count FROM orders WHERE status = 'pending'`);

        const report = `📊 **የሱቅ አጠቃላይ ሪፖርት**\n\n✅ **የተሸጡ እቃዎች ብዛት፦** ${soldData.count || 0}\n💰 **የተሰበሰበ ገንዘብ፦** ${soldData.total || 0} ብር\n⏳ **በሂደት ላይ ያሉ (Pending)፦** ${pendingData.count || 0}`;
        ctx.reply(report, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
    }
});

// 8. Contact Info
bot.hears('📞 አድራሻ እና ግንኙነት', (ctx) => {
    ctx.reply("📍 **የሱቃችን አድራሻ እና መረጃ፦**\n\n🏢 አዲስ አበባ፣ ኢትዮጵያ\n📞 ስልክ፦ +251 900 000 000\n💬 ቴሌግራም አድሚን፦ @YourAdminUsername", { parse_mode: 'Markdown' });
});

// Express Web Server for Render
app.get('/', (req, res) => res.send('Telegram Store Bot Running 24/7'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Start Bot
bot.launch();