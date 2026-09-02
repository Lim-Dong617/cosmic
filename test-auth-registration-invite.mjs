import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const express = require('express');
const bcrypt = require('bcryptjs');

const databasePath = require.resolve('./server/database');
const authPath = require.resolve('./server/auth');

// 生产环境漏配邀请码时必须关闭注册，不能退化为开放注册。
const failClosedResult = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { authRouter } = require(process.argv[1]);
    const registrationLayer = authRouter.stack.find(layer => layer.route?.path === '/register');
    let responseStatus = 200;
    let responseBody = null;
    const response = {
        status(status) { responseStatus = status; return this; },
        json(body) { responseBody = body; return this; }
    };
    (async () => {
        await registrationLayer.route.stack[0].handle({
            body: { username: 'blocked_user', password: 'secret123', inviteCode: 'anything' }
        }, response);
        assert.equal(responseStatus, 403);
        assert.match(responseBody.error, /邀请码无效/);
    })().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
`, authPath], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        NODE_ENV: 'test'
    }
});
assert.ifError(failClosedResult.error);
assert.equal(failClosedResult.status, 0, `${failClosedResult.stdout || ''}${failClosedResult.stderr || ''}`);

process.env.REGISTRATION_INVITE_CODE = 'test-invite-code';
process.env.JWT_SECRET = 'registration-invite-test-secret';

const originalDatabaseModule = require.cache[databasePath];
const originalAuthModule = require.cache[authPath];

const calls = {
    findByUsername: 0,
    create: 0,
    updateLastLogin: 0
};
const loginPasswordHash = await bcrypt.hash('correct-password', 4);

const userOps = {
    async findByUsername(username) {
        calls.findByUsername += 1;
        if (username === 'duplicate') {
            return { id: 8, username: 'duplicate' };
        }
        if (username === 'login-user') {
            return {
                id: 9,
                username: 'login-user',
                password_hash: loginPasswordHash,
                display_name: '登录用户',
                avatar_color: '#6C63FF'
            };
        }
        return null;
    },
    async create({ username, displayName, passwordHash, avatarColor }) {
        calls.create += 1;
        assert.equal(username, 'invited_user');
        assert.equal(displayName, '受邀用户');
        assert.ok(await bcrypt.compare('secret123', passwordHash));
        assert.match(avatarColor, /^#[0-9A-F]{6}$/i);
        return { lastInsertRowid: 42 };
    },
    async updateLastLogin() {
        calls.updateLastLogin += 1;
    }
};

require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { userOps, conversationOps: {} }
};
delete require.cache[authPath];

const { authRouter } = require(authPath);
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

const server = createServer(app);
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});

const { port } = server.address();
const postJson = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { response, data: await response.json() };
};

try {
    const baseRegistration = {
        username: 'invited_user',
        password: 'secret123',
        displayName: '受邀用户'
    };

    const missingInvite = await postJson('/api/auth/register', baseRegistration);
    assert.equal(missingInvite.response.status, 403);
    assert.match(missingInvite.data.error, /邀请码无效/);
    assert.deepEqual(calls, { findByUsername: 0, create: 0, updateLastLogin: 0 });

    const wrongInvite = await postJson('/api/auth/register', {
        ...baseRegistration,
        inviteCode: 'wrong-code'
    });
    assert.equal(wrongInvite.response.status, 403);
    assert.match(wrongInvite.data.error, /邀请码无效/);
    assert.deepEqual(calls, { findByUsername: 0, create: 0, updateLastLogin: 0 });

    const validInvite = await postJson('/api/auth/register', {
        ...baseRegistration,
        inviteCode: 'test-invite-code'
    });
    assert.equal(validInvite.response.status, 200);
    assert.equal(validInvite.data.success, true);
    assert.equal(validInvite.data.user.id, 42);
    assert.equal(validInvite.data.user.username, 'invited_user');
    assert.equal(typeof validInvite.data.token, 'string');
    assert.deepEqual(calls, { findByUsername: 1, create: 1, updateLastLogin: 1 });

    const duplicate = await postJson('/api/auth/register', {
        username: 'duplicate',
        password: 'secret123',
        inviteCode: 'test-invite-code'
    });
    assert.equal(duplicate.response.status, 409);
    assert.match(duplicate.data.error, /已被注册/);
    assert.deepEqual(calls, { findByUsername: 2, create: 1, updateLastLogin: 1 });

    const login = await postJson('/api/auth/login', {
        username: 'login-user',
        password: 'correct-password'
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.success, true);
    assert.equal(login.data.user.username, 'login-user');
    assert.deepEqual(calls, { findByUsername: 3, create: 1, updateLastLogin: 2 });
} finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (originalDatabaseModule) require.cache[databasePath] = originalDatabaseModule;
    else delete require.cache[databasePath];
    if (originalAuthModule) require.cache[authPath] = originalAuthModule;
    else delete require.cache[authPath];
}

console.log('✅ 注册邀请码服务端校验测试通过');
