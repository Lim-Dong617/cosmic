import React, { useState } from 'react';
import axios from 'axios';
import { User, Lock, Eye, EyeOff, ArrowRight, UserPlus, LogIn } from 'lucide-react';
import LoginOrb from './LoginOrb.jsx';

export default function LoginPage({ onLoginSuccess }) {
    const [isRegister, setIsRegister] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!username.trim() || !password.trim()) {
            setError('请填写用户名和密码');
            return;
        }

        if (isRegister) {
            if (password !== confirmPassword) {
                setError('两次输入的密码不一致');
                return;
            }
            if (password.length < 6) {
                setError('密码长度不能少于6个字符');
                return;
            }
        }

        setLoading(true);

        try {
            const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
            const payload = isRegister
                ? { username: username.trim(), password, displayName: displayName.trim() || username.trim() }
                : { username: username.trim(), password };

            const res = await axios.post(endpoint, payload);

            if (res.data.success) {
                // 保存token和用户信息
                localStorage.setItem('cosmic_token', res.data.token);
                localStorage.setItem('cosmic_user', JSON.stringify(res.data.user));
                onLoginSuccess(res.data.user, res.data.token);
            }
        } catch (err) {
            setError(err.response?.data?.error || '操作失败，请重试');
        } finally {
            setLoading(false);
        }
    };

    const switchMode = () => {
        setIsRegister(!isRegister);
        setError('');
        setPassword('');
        setConfirmPassword('');
    };

    return (
        <div className="login-page">
            {/* 背景动效 */}
            <div className="login-bg-effects">
                <div className="login-bg-orb login-bg-orb-1" />
                <div className="login-bg-orb login-bg-orb-2" />
                <div className="login-bg-orb login-bg-orb-3" />
                <div className="login-grid-overlay" />
            </div>

            <div className="login-container">
                <section className="login-visual">
                    <LoginOrb />
                    <div className="login-visual-heading">
                        <span className="login-visual-kicker"><i /> COSMIC INTELLIGENCE</span>
                        <h1>把需求，转化为可度量的功能规模</h1>
                        <p>AI 驱动的功能过程识别、COSMIC 数据移动拆分与质量校验。</p>
                    </div>
                    <div className="login-visual-badges" aria-label="系统核心能力">
                        <span>智能识别</span>
                        <span>ERWX 拆分</span>
                        <span>质量校验</span>
                    </div>
                </section>

                <section className="login-panel">
                    <div className="login-brand">
                        <div className="login-brand-lockup" aria-label="COSMIC 功能规模智能分析系统">
                            <div className="login-brand-mark" aria-hidden="true">
                                <svg viewBox="0 0 64 64" focusable="false">
                                    <defs>
                                        <linearGradient id="brand-cube-top" x1="0" y1="0" x2="1" y2="1">
                                            <stop offset="0" stopColor="#a7f3ff" />
                                            <stop offset="1" stopColor="#25c7ea" />
                                        </linearGradient>
                                        <linearGradient id="brand-cube-left" x1="0" y1="0" x2="0.9" y2="1">
                                            <stop offset="0" stopColor="#168ad8" />
                                            <stop offset="1" stopColor="#07549a" />
                                        </linearGradient>
                                        <linearGradient id="brand-cube-right" x1="0" y1="0" x2="0.85" y2="1">
                                            <stop offset="0" stopColor="#39d69f" />
                                            <stop offset="1" stopColor="#0c8c7b" />
                                        </linearGradient>
                                    </defs>
                                    <g className="login-brand-cube login-brand-cube-a">
                                        <path d="M8 29 20 22l12 7-12 7z" fill="url(#brand-cube-top)" />
                                        <path d="M8 29l12 7v14L8 43z" fill="url(#brand-cube-left)" />
                                        <path d="m20 36 12-7v14l-12 7z" fill="url(#brand-cube-right)" />
                                    </g>
                                    <g className="login-brand-cube login-brand-cube-b">
                                        <path d="m23 14 11-6 11 6-11 6z" fill="url(#brand-cube-top)" />
                                        <path d="m23 14 11 6v13l-11-6z" fill="url(#brand-cube-left)" />
                                        <path d="m34 20 11-6v13l-11 6z" fill="url(#brand-cube-right)" />
                                    </g>
                                    <g className="login-brand-cube login-brand-cube-c">
                                        <path d="m35 35 11-6 11 6-11 6z" fill="url(#brand-cube-top)" />
                                        <path d="m35 35 11 6v13l-11-6z" fill="url(#brand-cube-left)" />
                                        <path d="m46 41 11-6v13l-11 6z" fill="url(#brand-cube-right)" />
                                    </g>
                                    <path className="login-brand-signal" d="m20 28 14-8 12 7M20 37l14-8 12 7" />
                                </svg>
                            </div>
                            <span className="login-brand-divider" aria-hidden="true" />
                            <span className="login-brand-copy">
                                <strong>COSMIC</strong>
                                <span>功能规模智能分析系统</span>
                            </span>
                        </div>
                    </div>

                    {/* 登录卡片 */}
                    <div className="login-card">
                        <div className="login-card-header">
                            <span className="login-card-eyebrow">COSMIC WORKSPACE</span>
                            <h2>{isRegister ? '创建账号' : '欢迎回来'}</h2>
                            <p>{isRegister ? '注册新账户开始使用' : '登录以访问您的分析历史'}</p>
                        </div>

                        <form onSubmit={handleSubmit} className="login-form">
                            <div className="login-field">
                                <label htmlFor="login-username">
                                    <User size={16} />
                                    用户名
                                </label>
                                <input
                                    id="login-username"
                                    type="text"
                                    value={username}
                                    onChange={e => setUsername(e.target.value)}
                                    placeholder="请输入用户名"
                                    autoComplete="username"
                                    autoFocus
                                />
                            </div>

                            {isRegister && (
                                <div className="login-field">
                                    <label htmlFor="login-display-name">
                                        <UserPlus size={16} />
                                        显示名称 <span className="login-optional">（选填）</span>
                                    </label>
                                    <input
                                        id="login-display-name"
                                        type="text"
                                        value={displayName}
                                        onChange={e => setDisplayName(e.target.value)}
                                        placeholder="您希望显示的名称"
                                    />
                                </div>
                            )}

                            <div className="login-field">
                                <label htmlFor="login-password">
                                    <Lock size={16} />
                                    密码
                                </label>
                                <div className="login-password-wrap">
                                    <input
                                        id="login-password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder={isRegister ? '至少6个字符' : '请输入密码'}
                                        autoComplete={isRegister ? 'new-password' : 'current-password'}
                                    />
                                    <button
                                        type="button"
                                        className="login-password-toggle"
                                        onClick={() => setShowPassword(!showPassword)}
                                        tabIndex={-1}
                                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                    >
                                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                            </div>

                            {isRegister && (
                                <div className="login-field">
                                    <label htmlFor="login-confirm-password">
                                        <Lock size={16} />
                                        确认密码
                                    </label>
                                    <input
                                        id="login-confirm-password"
                                        type="password"
                                        value={confirmPassword}
                                        onChange={e => setConfirmPassword(e.target.value)}
                                        placeholder="再次输入密码"
                                        autoComplete="new-password"
                                    />
                                </div>
                            )}

                            {error && (
                                <div className="login-error">
                                    <span>⚠️</span> {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                className="login-submit-btn"
                                disabled={loading}
                            >
                                {loading ? (
                                    <span className="login-spinner" />
                                ) : isRegister ? (
                                    <>
                                        <UserPlus size={18} />
                                        注册
                                    </>
                                ) : (
                                    <>
                                        <LogIn size={18} />
                                        登录
                                    </>
                                )}
                                {!loading && <ArrowRight size={16} className="login-btn-arrow" />}
                            </button>
                        </form>

                        <div className="login-switch">
                            {isRegister ? (
                                <span>已有账号？ <button type="button" onClick={switchMode}>立即登录</button></span>
                            ) : (
                                <span>没有账号？ <button type="button" onClick={switchMode}>立即注册</button></span>
                            )}
                        </div>
                    </div>

                    <div className="login-footer">
                        <p>COSMIC Function Point · Powered by AI</p>
                    </div>
                </section>
            </div>
        </div>
    );
}
