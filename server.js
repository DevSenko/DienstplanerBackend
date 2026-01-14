import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import * as msal from '@azure/msal-node';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
    origin: '*', // Erlaubt alle Domains
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' })); // Erhöhtes Limit für Profilbilder (Base64)
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Error & Activity Logger (logs only errors or important actions to avoid spam)
app.use((req, res, next) => {
    const oldJson = res.json;
    res.json = function(data) {
        if (res.statusCode >= 400) {
            console.log(`[${res.statusCode}] ${req.method} ${req.url} - Error:`, data.error || data);
        }
        return oldJson.apply(res, arguments);
    };
    next();
});



const PORT = process.env.PORT || 5000;

// MariaDB Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
    idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    multipleStatements: true // Erlaubt das Ausführen mehrerer SQL Statements
});

// Automatische Datenbank-Initialisierung
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Connected to MariaDB');

        // Tabellen erstellen
        const schema = `
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                microsoft_id VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                role ENUM('azubi', 'ausbilder', 'admin') DEFAULT 'azubi',
                points INT DEFAULT 0,
                free_cards INT DEFAULT 0,
                used_cards INT DEFAULT 0,
                lehrjahr INT DEFAULT 1,
                exit_date DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS user_restrictions (
                user_id INT,
                restriction_type VARCHAR(50),
                PRIMARY KEY (user_id, restriction_type),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS cancelled_days (
                id INT AUTO_INCREMENT PRIMARY KEY,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                reason VARCHAR(255)
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS duties (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                points_value INT DEFAULT 1,
                year_restriction INT DEFAULT NULL
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS schedule (
                id INT AUTO_INCREMENT PRIMARY KEY,
                date DATE NOT NULL,
                duty_id VARCHAR(50),
                user_id INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, duty_id),
                INDEX (duty_id),
                INDEX (user_id),
                FOREIGN KEY (duty_id) REFERENCES duties(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS absences (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                type VARCHAR(50) DEFAULT 'vacation',
                reason TEXT,
                INDEX (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB;

            CREATE TABLE IF NOT EXISTS logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                action VARCHAR(255) NOT NULL,
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB;

            INSERT INTO duties (id, name, description, points_value, year_restriction) VALUES
            ('kitchen1', 'Küchendienst 1', 'Reinigung der Küche, Geschirrspüler einräumen/ausräumen.', 2, NULL),
            ('kitchen2', 'Küchendienst 2', 'Reinigung der Tische und Oberflächen.', 2, NULL),
            ('sweep1', 'Kehren 1', 'Fegen des vorderen Bereichs.', 1, 1),
            ('sweep2', 'Kehren 2', 'Fegen des hinteren Bereichs.', 1, 2),
            ('sweep3', 'Kehren 3', 'Fegen der Werkstatt.', 1, 3),
            ('trash1', 'Müll 1', 'Leeren der Restmülltonnen.', 1, NULL),
            ('trash2', 'Müll 2', 'Leeren der Papiertonnen.', 1, NULL)
            ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);
        `;

        await connection.query(schema);
        
        // Spalten nachträglich hinzufügen falls sie fehlen (Migration)
        try {
            // Upgrade cancelled_days if it has the old structure
            const [cancelCols] = await connection.query("SHOW COLUMNS FROM cancelled_days LIKE 'date'");
            if (cancelCols.length > 0) {
                await connection.query('DROP TABLE cancelled_days');
                await connection.query(`
                    CREATE TABLE cancelled_days (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        start_date DATE NOT NULL,
                        end_date DATE NOT NULL,
                        reason VARCHAR(255)
                    ) ENGINE=InnoDB
                `);
                console.log('✅ Upgraded cancelled_days to range-based');
            }

            // Check if created_at exists in schedule
            const [scheduleCols] = await connection.query("SHOW COLUMNS FROM schedule LIKE 'created_at'");
            if (scheduleCols.length === 0) {
                await connection.query('ALTER TABLE schedule ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
                console.log('✅ Added created_at to schedule');
            }

            // Check if used_cards exists in users
            const [userCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'used_cards'");
            if (userCols.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN used_cards INT DEFAULT 0');
                console.log('✅ Added used_cards to users');
            }

            // Check if lehrjahr exists in users
            const [lehrjahrCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'lehrjahr'");
            if (lehrjahrCols.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN lehrjahr INT DEFAULT 1');
                console.log('✅ Added lehrjahr to users');
            }

            // Upgrade exit_date to DATETIME if it is DATE, or add if missing
            const [exitCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'exit_date'");
            if (exitCols.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN exit_date DATETIME DEFAULT NULL');
                console.log('✅ Added exit_date to users');
            } else if (exitCols[0].Type === 'date') {
                await connection.query('ALTER TABLE users MODIFY COLUMN exit_date DATETIME DEFAULT NULL');
                console.log('✅ Upgraded exit_date to DATETIME');
            }

            // Check if profile_picture exists in users
            const [picCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'profile_picture'");
            if (picCols.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN profile_picture LONGTEXT DEFAULT NULL');
                console.log('✅ Added profile_picture to users');
            }

            // Add adjustment columns
            const [scaleCol] = await connection.query("SHOW COLUMNS FROM users LIKE 'profile_scale'");
            if (scaleCol.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN profile_scale FLOAT DEFAULT 1.0, ADD COLUMN profile_pos_x INT DEFAULT 0, ADD COLUMN profile_pos_y INT DEFAULT 0');
                console.log('✅ Added profile adjustment columns');
            }

            // Add fixed columns to schedule
            const [fixedCol] = await connection.query("SHOW COLUMNS FROM schedule LIKE 'is_fixed'");
            if (fixedCol.length === 0) {
                await connection.query('ALTER TABLE schedule ADD COLUMN is_fixed BOOLEAN DEFAULT FALSE, ADD COLUMN earned_points INT DEFAULT 0');
                console.log('✅ Added is_fixed and earned_points to schedule');
            }

            // Check if password and needs_password_change exists
            const [pwdCol] = await connection.query("SHOW COLUMNS FROM users LIKE 'password'");
            if (pwdCol.length === 0) {
                await connection.query('ALTER TABLE users ADD COLUMN password VARCHAR(255) DEFAULT NULL, ADD COLUMN needs_password_change BOOLEAN DEFAULT FALSE');
                console.log('✅ Added password columns');
            }

            // Update microsoft_id to be nullable (for local users)
            await connection.query('ALTER TABLE users MODIFY COLUMN microsoft_id VARCHAR(255) DEFAULT NULL');

            // Update role ENUM to include azubi and ausbilder (removed moderator)
            await connection.query("ALTER TABLE users MODIFY COLUMN role ENUM('azubi', 'ausbilder', 'admin') DEFAULT 'azubi'");
            
            // Rename existing 'user' roles to 'azubi'
            await connection.query("UPDATE users SET role = 'azubi' WHERE role = 'user' OR role = 'moderator'");

            // Check if name is unique
            const [nameIndex] = await connection.query("SHOW INDEX FROM users WHERE Column_name = 'name' AND Non_unique = 0");
            if (nameIndex.length === 0) {
                try {
                    await connection.query('ALTER TABLE users ADD UNIQUE (name)');
                    console.log('✅ Added UNIQUE constraint to name in users');
                } catch (dupErr) {
                    console.error('❌ Could not add UNIQUE to name - duplicate names may already exist:', dupErr.message);
                }
            }
        } catch (migrationErr) {
            console.error('❌ Migration Error:', migrationErr.message);
        }

        console.log('✅ Database Tables initialized');
        connection.release();
    } catch (err) {
        console.error('❌ Database Initialization Error:');
        console.error('Message:', err.message);
        process.exit(1); // Beendet den Server bei fatalem DB-Fehler
    }
}

initDatabase();

// MSAL Configuration
const msalConfig = {
    auth: {
        clientId: process.env.MS_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
        clientSecret: process.env.MS_CLIENT_SECRET,
    }
};

const pca = new msal.ConfidentialClientApplication(msalConfig);

// Middleware for Auth
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Aktuelle Daten aus der DB holen (Sync)
        const [users] = await pool.query('SELECT id, role, name, microsoft_id FROM users WHERE id = ?', [decoded.id]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'User existiert nicht mehr' });
        }
        
        // req.user mit den frischen DB-Daten befüllen
        req.user = {
            ...decoded,
            role: users[0].role,
            name: users[0].name
        };
        
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// --- AUTH ROUTES ---

app.get('/api/auth/login', async (req, res) => {
    const authCodeUrlParameters = {
        scopes: ["user.read", "openid", "profile", "email"],
        redirectUri: process.env.REDIRECT_URI,
    };

    try {
        const response = await pca.getAuthCodeUrl(authCodeUrlParameters);
        res.json({ url: response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/local', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Normaler Login über DB
        const [users] = await pool.query('SELECT * FROM users WHERE email = ? OR name = ?', [username, username]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        }

        const user = users[0];
        if (user.password !== password) {
            return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        }

        const token = jwt.sign(
            { id: user.id, msId: user.microsoft_id, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token, user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/callback', async (req, res) => {
    const { code } = req.body;
    const tokenRequest = {
        code,
        scopes: ["user.read", "openid", "profile", "email"],
        redirectUri: process.env.REDIRECT_URI,
    };

    try {
        const response = await pca.acquireTokenByCode(tokenRequest);
        const { sub: msId, name, preferred_username: email } = response.idTokenClaims;

        // Check or create user in MariaDB
        // We use ON DUPLICATE KEY UPDATE to handle cases where the email already exists 
        // (e.g. from local creation) but the microsoft_id is new.
        await pool.query(
            `INSERT INTO users (microsoft_id, name, email) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE microsoft_id = VALUES(microsoft_id), name = VALUES(name)`,
            [msId, name, email]
        );

        const [users] = await pool.query('SELECT * FROM users WHERE microsoft_id = ?', [msId]);
        let user = users[0];

        const token = jwt.sign(
            { id: user.id, msId: user.microsoft_id, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token, user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Helper to get calculated points
async function getUserStats(userId) {
    // Check if created_at column exists in schedule to avoid 500 errors
    let createdAtCol = 's.created_at';
    try {
        await pool.query('SELECT created_at FROM schedule LIMIT 1');
    } catch (e) {
        createdAtCol = 's.date'; // Fallback to date if created_at doesn't exist yet
    }

    // Points are earned if:
    // 1. The duty is already finalized (is_fixed = 1)
    // 2. The duty date is today (date = CURRENT_DATE) AND was assigned on or before today
    const [rows] = await pool.query(`
        SELECT 
            (SELECT SUM(earned_points) FROM schedule WHERE user_id = ? AND is_fixed = 1) as fixed_points,
            (SELECT SUM(d.points_value) 
             FROM schedule s
             JOIN duties d ON s.duty_id = d.id
             WHERE s.user_id = ? 
             AND s.date = CURRENT_DATE
             AND s.is_fixed = 0
             AND DATE(${createdAtCol}) <= s.date) as today_points
    `, [userId, userId]);

    const totalEarned = Number(rows[0].fixed_points || 0) + Number(rows[0].today_points || 0);

    // Get manual overrides from users table
    let usedCards = 0;
    let manualFreeCards = 0;
    let manualPoints = 0;
    try {
        const [user] = await pool.query('SELECT used_cards, free_cards, points FROM users WHERE id = ?', [userId]);
        usedCards = Number(user[0]?.used_cards || 0);
        manualFreeCards = Number(user[0]?.free_cards || 0);
        manualPoints = Number(user[0]?.points || 0);
    } catch (e) {
        console.error("Error fetching manual stats:", e);
    }

    // Berechnung: Verdiente Karten + Manuelle Karten
    const earnedFreeCards = Math.floor(totalEarned / 100);
    const totalFreeCards = earnedFreeCards + manualFreeCards;
    
    // Aktuelle Punkte: Verdiente Punkte (Rest von 100) + Manuelle Punkte
    const currentPointsRaw = (totalEarned % 100) + manualPoints;
    const displayPoints = currentPointsRaw % 100;
    const pointsOverflowCards = Math.floor(currentPointsRaw / 100);
    
    const finalFreeCards = Math.max(0, (totalFreeCards + pointsOverflowCards) - usedCards);
    
    // Check password status and registration date
    const [userRow] = await pool.query('SELECT needs_password_change, created_at FROM users WHERE id = ?', [userId]);
    const registrationDate = new Date(userRow[0]?.created_at || new Date());
    const now = new Date();
    const diffTime = Math.abs(now - registrationDate);
    const diffWeeks = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 7)));

    // Total duties performed
    const [dutyRows] = await pool.query('SELECT COUNT(*) as count FROM schedule WHERE user_id = ?', [userId]);
    const dutyCount = dutyRows[0].count || 0;

    // Improved Quota: Weighted average (60% last 4 weeks, 40% overall)
    const [recentRows] = await pool.query(`
        SELECT COUNT(*) as count 
        FROM schedule 
        WHERE user_id = ? 
        AND date >= DATE_SUB(CURRENT_DATE, INTERVAL 4 WEEK)
    `, [userId]);
    const recentCount = recentRows[0].count || 0;
    const recentQuote = recentCount / 4;
    const overallQuote = dutyCount / diffWeeks;
    
    // Weighted Quota
    const weightedQuote = (recentQuote * 0.6) + (overallQuote * 0.4);

    return {
        points: displayPoints,
        total_points: totalEarned + (manualFreeCards * 100) + manualPoints,
        free_cards: finalFreeCards,
        used_cards: usedCards,
        needs_password_change: !!userRow[0]?.needs_password_change,
        duty_count: dutyCount,
        weeks_active: diffWeeks,
        duty_quote: parseFloat(weightedQuote.toFixed(2)),
        raw_quote: parseFloat(overallQuote.toFixed(2)),
        recent_quote: parseFloat(recentQuote.toFixed(2))
    };
}

// Finalize past duties
async function finalizePastDuties() {
    try {
        // Find all non-fixed duties in the past
        // Points are earned if: 
        // 1. date < CURRENT_DATE
        // 2. assigned on or before the duty date (created_at <= date)
        await pool.query(`
            UPDATE schedule s
            JOIN duties d ON s.duty_id = d.id
            SET s.is_fixed = 1, s.earned_points = d.points_value
            WHERE s.date < CURRENT_DATE
            AND s.is_fixed = 0
            AND DATE(s.created_at) <= s.date
        `);
        
        // Also fix past duties that were assigned too late but should still be fixed (with 0 points)
        await pool.query(`
            UPDATE schedule
            SET is_fixed = 1, earned_points = 0
            WHERE date < CURRENT_DATE
            AND is_fixed = 0
        `);
    } catch (err) {
        console.error('Finalization Error:', err);
    }
}

// Log helper
async function createLog(userId, action, details) {
    try {
        await pool.query(
            'INSERT INTO logs (user_id, action, details) VALUES (?, ?, ?)',
            [userId, action, details]
        );
    } catch (err) {
        console.error('Logging Error:', err);
    }
}

// Auto-Assignment logic for Fridays
async function autoAssignDuties() {
    console.log('--- STARTING AUTO-ASSIGNMENT ---');
    try {
        await finalizePastDuties();
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];

        // 1. Get all duties
        const [duties] = await pool.query('SELECT * FROM duties');
        
        // 2. Get current schedule for today
        const [currentSchedule] = await pool.query('SELECT duty_id FROM schedule WHERE date = ?', [dateStr]);
        const occupiedDutyIds = currentSchedule.map(s => s.duty_id);

        // 3. Find missing duties
        const missingDuties = duties.filter(d => !occupiedDutyIds.includes(d.id));
        if (missingDuties.length === 0) {
            console.log('All duties already assigned.');
            return;
        }

        // 4. Get all available users (Azubis)
        // We filter out users who are already assigned today or are sick
        const [users] = await pool.query(`
            SELECT u.id, u.name, u.lehrjahr
            FROM users u
            WHERE u.role = 'azubi'
            AND u.id NOT IN (SELECT user_id FROM schedule WHERE date = ? AND user_id IS NOT NULL)
            AND u.id NOT IN (SELECT user_id FROM absences WHERE ? BETWEEN start_date AND end_date)
        `, [dateStr, dateStr]);

        if (users.length === 0) {
            console.log('No available users for auto-assignment.');
            return;
        }

        // 5. Get stats for each user to sort by quota
        const usersWithStats = await Promise.all(users.map(async (u) => {
            const stats = await getUserStats(u.id);
            // Get restrictions
            const [restr] = await pool.query('SELECT restriction_type FROM user_restrictions WHERE user_id = ?', [u.id]);
            const restrictions = restr.map(r => r.restriction_type);
            return { ...u, duty_quote: stats.duty_quote, restrictions };
        }));

        // Sort by quota ascending (lowest first)
        usersWithStats.sort((a, b) => a.duty_quote - b.duty_quote);

        // 6. Assign missing duties
        for (const duty of missingDuties) {
            const dutyType = duty.name.toLowerCase().includes('küchen') ? 'Küchendienst' :
                             duty.name.toLowerCase().includes('kehren') ? 'Kehren' :
                             duty.name.toLowerCase().includes('müll') ? 'Müll' : null;

            // Find first user who is not restricted and not yet assigned in this loop
            const candidates = usersWithStats.filter(u => !u.assigned_now);
            const targetUser = candidates.find(u => {
                // Year restriction
                if (duty.year_restriction && u.lehrjahr !== duty.year_restriction) return false;
                // Type restriction
                if (dutyType && u.restrictions.includes(dutyType)) return false;
                return true;
            });

            if (targetUser) {
                await pool.query(
                    'INSERT INTO schedule (date, duty_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
                    [dateStr, duty.id, targetUser.id]
                );
                targetUser.assigned_now = true;
                await createLog(null, 'AUTO_ASSIGN', `Dienst ${duty.name} wurde automatisch an ${targetUser.name} zugewiesen.`);
                console.log(`Auto-assigned ${duty.name} to ${targetUser.name}`);
            }
        }
    } catch (err) {
        console.error('Auto-Assignment Error:', err);
    }
    console.log('--- AUTO-ASSIGNMENT FINISHED ---');
}

// --- DEV / SIMULATION ROUTES ---
app.post('/api/dev/generate-users', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can use dev tools' });
    try {
        const firstNames = ['Max', 'Lisa', 'Tim', 'Sarah', 'Kevin', 'Julia', 'Ben', 'Emma'];
        const lastNames = ['Müller', 'Schmidt', 'Weber', 'Fischer', 'Meyer', 'Wagner'];
        
        for (let i = 0; i < 5; i++) {
            const name = `SIM_${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}_${Math.floor(Math.random() * 1000)}`;
            const email = `sim_${Math.random().toString(36).substring(7)}@simulation.test`;
            const lehrjahr = Math.floor(Math.random() * 4) + 1;
            
            // Simuliere Registrierung vor 4 Wochen
            const createdAt = new Date();
            createdAt.setDate(createdAt.getDate() - 28);
            
            await pool.query(
                'INSERT INTO users (name, email, role, lehrjahr, created_at, password) VALUES (?, ?, "azubi", ?, ?, "start123")',
                [name, email, lehrjahr, createdAt]
            );
        }
        await createLog(req.user.id, 'DEV_SIMULATION', '5 Test-Benutzer generiert.');
        res.json({ success: true, message: '5 Test-Benutzer erstellt' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/dev/generate-duties', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can use dev tools' });
    try {
        const [users] = await pool.query('SELECT id FROM users WHERE role = "azubi"');
        const [duties] = await pool.query('SELECT id FROM duties');
        
        if (users.length === 0) return res.status(400).json({ error: 'Keine Azubis vorhanden' });

        const today = new Date();
        // Generiere Dienste für die letzten 4 Freitage
        for (let i = 1; i <= 4; i++) {
            const date = new Date();
            date.setDate(today.getDate() - (today.getDay() + 2) % 7 - (i * 7)); // Letzte Freitage
            const dateStr = date.toISOString().split('T')[0];

            for (const duty of duties) {
                const randomUser = users[Math.floor(Math.random() * users.length)].id;
                await pool.query(
                    'INSERT IGNORE INTO schedule (date, duty_id, user_id, is_fixed, earned_points) VALUES (?, ?, ?, 1, 1)',
                    [dateStr, duty.id, randomUser]
                );
            }
        }
        await createLog(req.user.id, 'DEV_SIMULATION', 'Vergangene Dienste simuliert.');
        res.json({ success: true, message: 'Vergangene Dienste generiert' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/dev/clear-sim', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can use dev tools' });
    try {
        await pool.query('DELETE FROM users WHERE name LIKE "SIM_%"');
        await createLog(req.user.id, 'DEV_SIMULATION', 'Simulationsdaten bereinigt.');
        res.json({ success: true, message: 'Test-Benutzer gelöscht' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- USER ROUTES ---

app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        await finalizePastDuties();
        const [users] = await pool.query('SELECT id, microsoft_id, name, email, role, points, free_cards, used_cards, lehrjahr, exit_date, created_at, profile_picture, profile_scale, profile_pos_x, profile_pos_y FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        
        const stats = await getUserStats(req.user.id);
        const user = { ...users[0], ...stats };
        
        res.json(user);
    } catch (error) {
        console.error("Error in /api/users/me:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:id/delete', authMiddleware, async (req, res) => {
    console.log(`DELETE (POST) request for user ${req.params.id} by ${req.user.name}`);
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    
    if (req.params.id == req.user.id) {
        return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });
    }

    try {
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [req.params.id]);
        if (targetUser.length === 0) {
            console.log(`User ${req.params.id} not found in DB`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        await createLog(req.user.id, 'BENUTZER_GELÖSCHT', `Benutzer ${targetUser[0].name} (ID: ${req.params.id}) wurde gelöscht.`);
        
        console.log(`Successfully deleted user ${targetUser[0].name}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users', authMiddleware, async (req, res) => {
    try {
        await finalizePastDuties();
        const [users] = await pool.query("SELECT id, name, role, lehrjahr, exit_date, email, profile_picture, profile_scale, profile_pos_x, profile_pos_y FROM users");
        
        const usersWithStats = await Promise.all(users.map(async (u) => {
            const stats = await getUserStats(u.id);
            let restrictions = [];
            if (req.user.role === 'admin' || req.user.role === 'ausbilder') {
                const [restr] = await pool.query('SELECT restriction_type FROM user_restrictions WHERE user_id = ?', [u.id]);
                restrictions = restr.map(r => r.restriction_type);
            }
            return { ...u, ...stats, restrictions };
        }));

        res.json(usersWithStats);
    } catch (error) {
        console.error("Error in /api/users:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/me/profile-settings', authMiddleware, async (req, res) => {
    const { scale, posX, posY, profile_picture } = req.body;
    try {
        if (profile_picture) {
            await pool.query('UPDATE users SET profile_scale = ?, profile_pos_x = ?, profile_pos_y = ?, profile_picture = ? WHERE id = ?', [scale, posX, posY, profile_picture, req.user.id]);
        } else {
            await pool.query('UPDATE users SET profile_scale = ?, profile_pos_x = ?, profile_pos_y = ? WHERE id = ?', [scale, posX, posY, req.user.id]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/me/password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
        const user = users[0];

        // If user had a password and provided current one, check it. 
        // If it was the default "IT2025!", we allow change if it matches.
        if (user.password && currentPassword && user.password !== currentPassword) {
            return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
        }

        await pool.query('UPDATE users SET password = ?, needs_password_change = FALSE WHERE id = ?', [newPassword, req.user.id]);
        await createLog(req.user.id, 'PASSWORT_GEÄNDERT', 'Benutzer hat sein Passwort geändert.');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { name, email, role, lehrjahr, password } = req.body;
    try {
        await pool.query(
            'INSERT INTO users (name, email, role, lehrjahr, password, needs_password_change) VALUES (?, ?, ?, ?, ?, TRUE)',
            [name, email, role, lehrjahr, password]
        );
        await createLog(req.user.id, 'BENUTZER_ERSTELLT', `Neuer Benutzer erstellt: ${name} (${email})`);
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            if (error.message.includes("'name'")) {
                return res.status(400).json({ error: 'Dieser Name wird bereits verwendet' });
            }
            return res.status(400).json({ error: 'E-Mail Adresse wird bereits verwendet' });
        }
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/me/use-card', authMiddleware, async (req, res) => {
    const { date } = req.body;
    try {
        await finalizePastDuties();
        const stats = await getUserStats(req.user.id);
        if (stats.free_cards <= 0) {
            return res.status(400).json({ error: 'Keine Freikarten verfügbar' });
        }

        if (date) {
            // Prüfen ob bereits eine Abwesenheit existiert
            const [existing] = await pool.query('SELECT * FROM absences WHERE user_id = ? AND start_date = ?', [req.user.id, date]);
            if (existing.length > 0) {
                return res.status(400).json({ error: 'Du bist für diesen Tag bereits als abwesend eingetragen.' });
            }

            // Abwesenheit erstellen
            await pool.query(
                'INSERT INTO absences (user_id, start_date, end_date, type, reason) VALUES (?, ?, ?, "Freikarte", "Freikarte eingelöst")',
                [req.user.id, date, date]
            );
            
            // Bestehenden Dienst an diesem Tag löschen falls vorhanden
            await pool.query('DELETE FROM schedule WHERE user_id = ? AND date = ?', [req.user.id, date]);
        }

        await pool.query('UPDATE users SET used_cards = used_cards + 1 WHERE id = ?', [req.user.id]);
        await createLog(req.user.id, 'FREIKARTE_GENUTZT', `Benutzer hat eine Freikarte${date ? ' für den ' + date : ''} eingelöst.`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- DUTY ROUTES ---

app.get('/api/duties', async (req, res) => {
    try {
        const [duties] = await pool.query('SELECT * FROM duties');
        res.json(duties);
    } catch (error) {
        console.error('Database error on /api/duties:', error);
        res.status(500).json({ error: 'Database connection failed' });
    }
});

// --- SCHEDULE ROUTES ---

app.get('/api/schedule', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT s.*, u.name as user_name, d.name as duty_name 
            FROM schedule s
            LEFT JOIN users u ON s.user_id = u.id
            LEFT JOIN duties d ON s.duty_id = d.id
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/schedule', authMiddleware, async (req, res) => {
    const { date, dutyId, userId } = req.body;
    
    try {
        // Check if duty is already fixed
        const [existingFixed] = await pool.query(
            'SELECT is_fixed FROM schedule WHERE date = ? AND duty_id = ?',
            [date, dutyId]
        );
        if (existingFixed.length > 0 && existingFixed[0].is_fixed && req.user.role !== 'admin' && req.user.role !== 'ausbilder') {
            return res.status(400).json({ error: 'Dieser Dienst ist bereits abgeschlossen und kann nicht mehr geändert werden.' });
        }

        // Also check date (past dates are fixed)
        const today = new Date();
        today.setHours(0,0,0,0);
        const targetDate = new Date(date);
        if (targetDate < today && req.user.role !== 'admin' && req.user.role !== 'ausbilder') {
            return res.status(400).json({ error: 'Vergangene Dienste können nicht mehr geändert werden.' });
        }

        if (userId) {
            // Check if user is an azubi, admin or ausbilder
            const [userCheck] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
            if (userCheck.length === 0 || (userCheck[0].role !== 'azubi' && userCheck[0].role !== 'admin' && userCheck[0].role !== 'ausbilder')) {
                return res.status(400).json({ error: 'Nur Azubis, Administratoren und Ausbilder können für Dienste eingeteilt werden.' });
            }

            // Check if person already has a duty on this day
            const [existing] = await pool.query(
                'SELECT * FROM schedule WHERE date = ? AND user_id = ? AND duty_id != ?',
                [date, userId, dutyId]
            );
            if (existing.length > 0) {
                return res.status(400).json({ error: 'Person ist an diesem Tag bereits für einen anderen Dienst eingeteilt.' });
            }

            // Check if person is sick/absent
            const [absent] = await pool.query(
                'SELECT * FROM absences WHERE user_id = ? AND ? BETWEEN start_date AND end_date',
                [userId, date]
            );
            if (absent.length > 0) {
                return res.status(400).json({ error: 'Person ist an diesem Tag als abwesend gemeldet.' });
            }

            // Check restrictions
            const [duty] = await pool.query('SELECT name FROM duties WHERE id = ?', [dutyId]);
            if (duty.length > 0) {
                const type = duty[0].name.toLowerCase().includes('küchen') ? 'Küchendienst' :
                             duty[0].name.toLowerCase().includes('kehren') ? 'Kehren' :
                             duty[0].name.toLowerCase().includes('müll') ? 'Müll' : null;
                
                if (type) {
                    const [restricted] = await pool.query(
                        'SELECT * FROM user_restrictions WHERE user_id = ? AND restriction_type = ?',
                        [userId, type]
                    );
                    if (restricted.length > 0) {
                        return res.status(400).json({ error: `Person hat eine Einschränkung für: ${type}` });
                    }
                }
            }
        }

        if (!userId) {
            // Get user who was assigned before deleting
            const [prev] = await pool.query('SELECT u.name FROM schedule s JOIN users u ON s.user_id = u.id WHERE s.date = ? AND s.duty_id = ?', [date, dutyId]);
            const prevName = prev[0]?.name || "Jemand";
            
            await pool.query('DELETE FROM schedule WHERE date = ? AND duty_id = ?', [date, dutyId]);
            await createLog(req.user.id, 'DIENST_ENTFERNT', `${prevName} wurde ${dutyId} am ${date} entfernt`);
        } else {
            // Check if created_at exists to avoid crash
            let updateSql = 'INSERT INTO schedule (date, duty_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)';
            try {
                const [cols] = await pool.query("SHOW COLUMNS FROM schedule LIKE 'created_at'");
                if (cols.length > 0) {
                    updateSql += ', created_at = CURRENT_TIMESTAMP';
                }
            } catch (e) {}

            await pool.query(updateSql, [date, dutyId, userId]);
            
            const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [userId]);
            const targetName = targetUser[0]?.name || userId;
            await createLog(req.user.id, 'DIENST_ZUGEWIESEN', `Dienst ${dutyId} am ${date} an ${targetName} zugewiesen`);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ABSENCE ROUTES ---

app.get('/api/absences', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT a.*, u.name as user_name FROM absences a JOIN users u ON a.user_id = u.id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/absences', authMiddleware, async (req, res) => {
    const { userId, startDate, endDate, type, reason } = req.body;
    try {
        // If admin or ausbilder, they can report anyone. Otherwise only themselves.
        const targetId = (req.user.role === 'admin' || req.user.role === 'ausbilder') ? (userId || req.user.id) : req.user.id;
        
        // Check if target user is an azubi, admin or ausbilder
        const [userCheck] = await pool.query('SELECT role FROM users WHERE id = ?', [targetId]);
        if (userCheck.length === 0 || (userCheck[0].role !== 'azubi' && userCheck[0].role !== 'admin' && userCheck[0].role !== 'ausbilder')) {
            return res.status(400).json({ error: 'Nur Azubis, Administratoren und Ausbilder können als abwesend gemeldet werden.' });
        }
        
        await pool.query(
            'INSERT INTO absences (user_id, start_date, end_date, type, reason) VALUES (?, ?, ?, ?, ?)',
            [targetId, startDate, endDate, type, reason]
        );
        
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [targetId]);
        const targetName = targetUser[0]?.name || targetId;
        await createLog(req.user.id, 'ABWESENHEIT_HINZUGEFÜGT', `Abwesenheit für ${targetName} hinzugefügt: ${type} vom ${startDate} bis ${endDate}`);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/absences/:id', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    try {
        const [absence] = await pool.query('SELECT a.*, u.name FROM absences a JOIN users u ON a.user_id = u.id WHERE a.id = ?', [req.params.id]);
        await pool.query('DELETE FROM absences WHERE id = ?', [req.params.id]);
        
        if (absence.length > 0) {
            await createLog(req.user.id, 'ABWESENHEIT_GELÖSCHT', `Abwesenheit für ${absence[0].name} (${absence[0].type}) wurde gelöscht.`);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- NEW ROUTES ---

app.get('/api/cancelled-days', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM cancelled_days');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/cancelled-days', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { startDate, endDate, reason } = req.body;
    try {
        await pool.query('INSERT INTO cancelled_days (start_date, end_date, reason) VALUES (?, ?, ?)', [startDate, endDate, reason]);
        await createLog(req.user.id, 'URLAUBSTAG_HINZUGEFÜGT', `Zeitraum: ${startDate} bis ${endDate}, Grund: ${reason}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/cancelled-days/:id', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    try {
        const [day] = await pool.query('SELECT * FROM cancelled_days WHERE id = ?', [req.params.id]);
        await pool.query('DELETE FROM cancelled_days WHERE id = ?', [req.params.id]);
        if (day.length > 0) {
            await createLog(req.user.id, 'URLAUBSTAG_GELÖSCHT', `Zeitraum: ${day[0].start_date} bis ${day[0].end_date} wurde gelöscht.`);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:id/restrictions', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT restriction_type FROM user_restrictions WHERE user_id = ?', [req.params.id]);
        res.json(rows.map(r => r.restriction_type));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/me/restrictions', authMiddleware, async (req, res) => {
    const { restrictions } = req.body; // Array of strings
    try {
        await pool.query('DELETE FROM user_restrictions WHERE user_id = ?', [req.user.id]);
        if (restrictions && restrictions.length > 0) {
            const values = restrictions.map(r => [req.user.id, r]);
            await pool.query('INSERT INTO user_restrictions (user_id, restriction_type) VALUES ?', [values]);
        }
        await createLog(req.user.id, 'EINSCHRÄNKUNG_GEÄNDERT', `Neue Einschränkungen: ${restrictions.join(', ') || 'Keine'}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:id/points/remove', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { amount } = req.body;
    try {
        await pool.query('UPDATE users SET points = GREATEST(0, points - ?) WHERE id = ?', [amount, req.params.id]);
        
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [req.params.id]);
        await createLog(req.user.id, 'PUNKTE_ABGEZOGEN', `${amount} Punkte wurden von ${targetUser[0]?.name || req.params.id} abgezogen.`);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:id/exit-date', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { exitDate } = req.body;
    try {
        await pool.query('UPDATE users SET exit_date = ? WHERE id = ?', [exitDate, req.params.id]);
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [req.params.id]);
        await createLog(req.user.id, 'AUSTRITTSDATUM_GEÄNDERT', `Austrittsdatum für ${targetUser[0]?.name || req.params.id} auf ${exitDate || 'NULL'} gesetzt.`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:id/lehrjahr', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { lehrjahr } = req.body;
    try {
        await pool.query('UPDATE users SET lehrjahr = ? WHERE id = ?', [lehrjahr, req.params.id]);
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [req.params.id]);
        await createLog(req.user.id, 'LEHRJAHR_GEÄNDERT', `Lehrjahr für ${targetUser[0]?.name || req.params.id} auf ${lehrjahr} gesetzt.`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update role, but prevent self-modification
app.all('/api/users/:id/role', authMiddleware, async (req, res) => {
    console.log(`Incoming ${req.method} request for user ${req.params.id} to update role`);
    console.log('Body:', req.body);
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    const { role } = req.body;
    
    if (req.params.id == req.user.id) {
        return res.status(400).json({ error: 'Du kannst deine eigene Rolle nicht ändern' });
    }

    try {
        await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
        const [targetUser] = await pool.query('SELECT name FROM users WHERE id = ?', [req.params.id]);
        await createLog(req.user.id, 'ROLLE_GEÄNDERT', `Rolle für ${targetUser[0]?.name || req.params.id} auf ${role} gesetzt.`);
        res.json({ success: true });
    } catch (error) {
        console.error('Role Update Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        await finalizePastDuties();
        const [users] = await pool.query('SELECT id, name FROM users');
        const statsPerUser = await Promise.all(users.map(async (u) => {
            const stats = await getUserStats(u.id);
            return { name: u.name, points: stats.points, total_points: stats.total_points };
        }));

        const totalPoints = statsPerUser.reduce((sum, u) => sum + u.total_points, 0);
        const [dutyCount] = await pool.query('SELECT COUNT(*) as count FROM schedule');
        const topUsers = [...statsPerUser].sort((a, b) => b.total_points - a.total_points).slice(0, 5);

        res.json({
            totalPoints,
            dutyCount: dutyCount[0].count,
            topUsers
        });
    } catch (error) {
        console.error("Error in /api/stats:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/logs', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') return res.status(403).json({ error: 'Access denied' });
    try {
        const [logs] = await pool.query(`
            SELECT l.*, u.name as user_name 
            FROM logs l 
            LEFT JOIN users u ON l.user_id = u.id 
            ORDER BY l.created_at DESC 
            LIMIT 200
        `);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Background Timer for Friday Auto-Assignment
let lastAutoAssignDate = null;
setInterval(() => {
    const now = new Date();
    const isFriday = now.getDay() === 5;
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const dateStr = now.toISOString().split('T')[0];

    // Check if it's Friday 14:35 and we haven't run it today
    if (isFriday && hours === 14 && minutes === 35 && lastAutoAssignDate !== dateStr) {
        lastAutoAssignDate = dateStr;
        autoAssignDuties();
    }
}, 30000); // Check every 30 seconds

// Route for Auto-Assignment (Admin & Ausbilder)
app.post('/api/dev/auto-assign', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'ausbilder') {
        return res.status(403).json({ error: 'Nur Administratoren und Ausbilder können die automatische Einteilung auslösen.' });
    }
    await autoAssignDuties();
    res.json({ success: true, message: 'Die automatische Einteilung wurde erfolgreich durchgeführt.' });
});

// Serve static files
app.use(express.static(__dirname));

// Serve the main HTML file for all non-API routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: `Endpoint ${req.method} ${req.url} not found` });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
