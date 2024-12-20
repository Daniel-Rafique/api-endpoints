module.exports = {
    apps: [
        {
            name: 'copytrade',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/copytrade',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'copytrade',
                PORT: '3001'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'pumpfun',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/pumpfun',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'pumpfun',
                PORT: '3002'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'moonshot',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/moonshot',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'moonshot',
                PORT: '3003'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'raydium',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/raydium',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'raydium',
                PORT: '3004'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'sniper',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/sniper',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'sniper',
                PORT: '3005'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'sol_spl',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/sol_spl',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'sol_spl',
                PORT: '3006'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        },
        {
            name: 'usdc_sol',
            script: './dist/index.js',
            cwd: '/root/devnet-api/instances/usdc_sol',
            env: {
                NODE_ENV: 'production',
                STRATEGY: 'usdc_sol',
                PORT: '3007'
            },
            watch: ['dist'],
            ignore_watch: ['node_modules', '*.log'],
            autorestart: true,
            max_memory_restart: '1G'
        }
    ]
};