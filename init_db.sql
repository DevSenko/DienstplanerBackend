-- ACHTUNG: Dieses Skript ist für MariaDB / MySQL. 
-- In VS Code unten rechts den Sprachmodus von 'MSSQL' auf 'MySQL' stellen!

CREATE DATABASE IF NOT EXISTS dienstplaner;
USE dienstplaner;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    microsoft_id VARCHAR(255) UNIQUE DEFAULT NULL,
    name VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) DEFAULT NULL,
    needs_password_change BOOLEAN DEFAULT FALSE,
    role ENUM('azubi', 'ausbilder', 'admin') DEFAULT 'azubi',
    points INT DEFAULT 0,
    free_cards INT DEFAULT 0,
    used_cards INT DEFAULT 0,
    lehrjahr INT DEFAULT 1,
    exit_date DATETIME DEFAULT NULL,
    profile_picture LONGTEXT DEFAULT NULL,
    profile_scale FLOAT DEFAULT 1.0,
    profile_pos_x INT DEFAULT 0,
    profile_pos_y INT DEFAULT 0,
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
    is_fixed BOOLEAN DEFAULT FALSE,
    earned_points INT DEFAULT 0,
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
