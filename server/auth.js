// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - 用户认证模块
// ═══════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('crypto');
const { userOps, conversationOps } = require('./database');

const router = express.Router();

// JWT 密钥（生产环境应从环境变量读取）
const JWT_SECRET = process.env.JWT_SECRET || 'cosmic-split-system-jwt-secret-2024';
const JWT_EXPIRES_IN = '7d'; // 7天有效期
const REGISTRATION_INVITE_CODE = String(process.env.REGISTRATION_INVITE_CODE || '').trim();

if (!REGISTRATION_INVITE_CODE) {
    console.warn('⚠️ 未配置 REGISTRATION_INVITE_CODE，新用户注册已关闭');
}

function isValidRegistrationInviteCode(value) {
    if (!REGISTRATION_INVITE_CODE || typeof value !== 'string') return false;
    const received = Buffer.from(value.trim(), 'utf8');
    const expected = Buffer.from(REGISTRATION_INVITE_CODE, 'utf8');
    return received.length === expected.length && timingSafeEqual(received, expected);
}

// 预设的头像颜色池
const AVATAR_COLORS = [
    '#6C63FF', '#FF6584', '#43B581', '#FAA61A',
    '#F47B67', '#7289DA', '#E91E63', '#00BCD4',
    '#8BC34A', '#FF5722', '#9C27B0', '#009688'
];

// ═══════════════════════ JWT中间件 ═══════════════════════

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登录，请先登录' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.username = decoded.username;
        next();
    } catch (err) {
        return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
}

// ═══════════════════════ 注册 ═══════════════════════

router.post('/register', async (req, res) => {
    try {
        const { username, password, displayName, inviteCode } = req.body;

        // 邀请码必须先于数据库查询校验，防止绕过前端直接开放注册。
        if (!isValidRegistrationInviteCode(inviteCode)) {
            return res.status(403).json({ error: '管理员邀请码无效，无法注册' });
        }

        // 校验输入
        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }
        if (username.length < 2 || username.length > 20) {
            return res.status(400).json({ error: '用户名长度需在2-20个字符之间' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: '密码长度不能少于6个字符' });
        }
        // 检查用户名是否合法 (字母、数字、中文、下划线)
        if (!/^[\w\u4e00-\u9fa5]+$/u.test(username)) {
            return res.status(400).json({ error: '用户名只能包含字母、数字、中文和下划线' });
        }

        // 检查用户名是否已存在
        const existing = await userOps.findByUsername(username);
        if (existing) {
            return res.status(409).json({ error: '该用户名已被注册' });
        }

        // 加密密码
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // 随机选择头像颜色
        const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

        // 创建用户
        const result = await userOps.create({
            username,
            passwordHash,
            displayName: displayName || username,
            avatarColor
        });

        const userId = result.lastInsertRowid;

        // 生成JWT
        const token = jwt.sign(
            { userId, username },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // 更新登录时间
        await userOps.updateLastLogin(userId);

        console.log(`✅ 新用户注册: ${username} (ID: ${userId})`);

        res.json({
            success: true,
            token,
            user: {
                id: userId,
                username,
                displayName: displayName || username,
                avatarColor
            }
        });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ error: '注册失败: ' + error.message });
    }
});

// ═══════════════════════ 登录 ═══════════════════════

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }

        // 查找用户
        const user = await userOps.findByUsername(username);
        if (!user) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // 验证密码
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // 生成JWT
        const token = jwt.sign(
            { userId: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // 更新登录时间
        await userOps.updateLastLogin(user.id);

        console.log(`✅ 用户登录: ${username}`);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarColor: user.avatar_color
            }
        });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录失败: ' + error.message });
    }
});

// ═══════════════════════ 获取当前用户信息 ═══════════════════════

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const user = await userOps.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }
        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarColor: user.avatar_color,
                createdAt: user.created_at
            }
        });
    } catch (error) {
        console.error('获取用户信息失败:', error);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});

// ═══════════════════════ 对话历史 API ═══════════════════════

// 获取对话列表
router.get('/conversations', authMiddleware, async (req, res) => {
    try {
        const conversations = await conversationOps.listByUser(req.userId);
        res.json({ success: true, conversations });
    } catch (error) {
        console.error('获取对话列表失败:', error);
        res.status(500).json({ error: '获取对话列表失败' });
    }
});

// 创建新对话
router.post('/conversations', authMiddleware, async (req, res) => {
    try {
        const { title, documentName, analysisMode } = req.body;
        const result = await conversationOps.create({
            userId: req.userId,
            title: title || '未命名分析',
            documentName: documentName || '',
            analysisMode: analysisMode || 'cosmic'
        });
        res.json({
            success: true,
            conversationId: result.lastInsertRowid
        });
    } catch (error) {
        console.error('创建对话失败:', error);
        res.status(500).json({ error: '创建对话失败' });
    }
});

// 保存/更新对话
router.put('/conversations/:id', authMiddleware, async (req, res) => {
    try {
        const conversationId = parseInt(req.params.id);
        const { title, messages, tableData, functionList, functionCount, cfpCount } = req.body;

        await conversationOps.update({
            id: conversationId,
            userId: req.userId,
            title: title || '未命名分析',
            messages: JSON.stringify(messages || []),
            tableData: JSON.stringify(tableData || []),
            functionList: functionList || '',
            functionCount: functionCount || 0,
            cfpCount: cfpCount || 0
        });

        res.json({ success: true });
    } catch (error) {
        console.error('保存对话失败:', error);
        res.status(500).json({ error: '保存对话失败' });
    }
});

// 获取对话详情
router.get('/conversations/:id', authMiddleware, async (req, res) => {
    try {
        const conversationId = parseInt(req.params.id);
        const conversation = await conversationOps.getById(conversationId, req.userId);
        if (!conversation) {
            return res.status(404).json({ error: '对话不存在' });
        }

        // 解析JSON字段
        conversation.messages = JSON.parse(conversation.messages || '[]');
        conversation.table_data = JSON.parse(conversation.table_data || '[]');

        res.json({ success: true, conversation });
    } catch (error) {
        console.error('获取对话详情失败:', error);
        res.status(500).json({ error: '获取对话详情失败' });
    }
});

// 删除对话
router.delete('/conversations/:id', authMiddleware, async (req, res) => {
    try {
        const conversationId = parseInt(req.params.id);
        await conversationOps.delete(conversationId, req.userId);
        res.json({ success: true });
    } catch (error) {
        console.error('删除对话失败:', error);
        res.status(500).json({ error: '删除对话失败' });
    }
});

module.exports = {
    authRouter: router,
    authMiddleware
};
