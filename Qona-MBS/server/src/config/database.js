require('dotenv').config();

// Use SQLite for local development if DB_TYPE is set to 'sqlite'
const useSQLite = process.env.DB_TYPE === 'sqlite';

const sqliteConfig = {
  dialect: 'sqlite',
  storage: './db/qona_mbs_dev.sqlite',
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  operatorsAliases: false,
  define: {
    timestamps: true,
    underscored: true,
    freezeTableName: false,
  },
};

const postgresConfig = {
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'qona_mbs_dev',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  dialect: 'postgres',
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  operatorsAliases: false,
  define: {
    timestamps: true,
    underscored: true,
    freezeTableName: false,
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
};

module.exports = {
  development: useSQLite ? sqliteConfig : postgresConfig,
  test: useSQLite ? { ...sqliteConfig, storage: './db/qona_mbs_test.sqlite' } : {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    database: 'qona_mbs_test',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    define: {
      timestamps: true,
      underscored: true,
      freezeTableName: false,
    },
  },
  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false,
    operatorsAliases: false,
    define: {
      timestamps: true,
      underscored: true,
      freezeTableName: false,
    },
    pool: {
      max: 20,
      min: 5,
      acquire: 30000,
      idle: 10000,
    },
    ssl: true,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    },
  },
};
