import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LoginPage from './LoginPage.jsx'
import './index.css'
import axios from 'axios'

function Root() {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(null);
    const [checking, setChecking] = useState(true);
    const [dbAvailable, setDbAvailable] = useState(true);

    // 启动时检查本地 token 是否有效
    useEffect(() => {
        const savedToken = localStorage.getItem('cosmic_token');
        const savedUser = localStorage.getItem('cosmic_user');

        // 检查是否是开发模式游客
        const isGuest = localStorage.getItem('cosmic_guest_mode');
        if (isGuest === 'true') {
            setUser({ id: 0, username: 'dev', displayName: '开发模式', avatarColor: '#6C63FF' });
            setToken('dev-mode');
            setChecking(false);
            return;
        }

        if (savedToken && savedUser) {
            // 验证 token
            axios.get('/api/auth/me', {
                headers: { Authorization: `Bearer ${savedToken}` }
            }).then(res => {
                if (res.data.success) {
                    setUser(res.data.user);
                    setToken(savedToken);
                } else {
                    clearAuth();
                }
            }).catch(() => {
                clearAuth();
                setDbAvailable(false);
            }).finally(() => {
                setChecking(false);
            });
        } else {
            // 检查数据库是否可用
            axios.post('/api/auth/login', { username: '__probe__', password: '__probe__' })
                .catch(err => {
                    if (err.response?.status === 500) {
                        setDbAvailable(false);
                    }
                })
                .finally(() => {
                    setChecking(false);
                });
        }
    }, []);

    const clearAuth = () => {
        localStorage.removeItem('cosmic_token');
        localStorage.removeItem('cosmic_user');
        localStorage.removeItem('cosmic_guest_mode');
        setUser(null);
        setToken(null);
    };

    const handleLoginSuccess = (userData, authToken) => {
        setUser(userData);
        setToken(authToken);
    };

    const handleGuestMode = () => {
        const code = window.prompt('请输入开发者代码：');
        if (code !== 'xiaoming') {
            alert('开发者代码错误，无法进入开发模式。');
            return;
        }
        const guestUser = { id: 0, username: 'dev', displayName: '开发模式', avatarColor: '#6C63FF' };
        localStorage.setItem('cosmic_guest_mode', 'true');
        setUser(guestUser);
        setToken('dev-mode');
    };

    const handleLogout = () => {
        clearAuth();
    };

    if (checking) {
        return (
            <div className="auth-checking">
                <div className="auth-checking-spinner" />
                <p>加载中...</p>
            </div>
        );
    }

    if (!user || !token) {
        return (
            <>
                <LoginPage onLoginSuccess={handleLoginSuccess} />
                {!dbAvailable && (
                    <div style={{
                        position: 'fixed', bottom: '32px', left: '50%', transform: 'translateX(-50%)',
                        zIndex: 10000, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px'
                    }}>
                        <div style={{
                            background: 'rgba(255,165,0,0.15)', border: '1px solid rgba(255,165,0,0.3)',
                            borderRadius: '8px', padding: '8px 16px', color: '#f0a030',
                            fontSize: '13px', backdropFilter: 'blur(8px)'
                        }}>
                            ⚠️ 数据库不可用，登录/注册功能暂不可用
                        </div>
                        <button
                            onClick={handleGuestMode}
                            style={{
                                background: 'linear-gradient(135deg, #6c5ce7, #a29bfe)',
                                color: '#fff', border: 'none', borderRadius: '10px',
                                padding: '10px 28px', fontSize: '15px', fontWeight: 600,
                                cursor: 'pointer', boxShadow: '0 4px 15px rgba(108,92,231,0.4)',
                                transition: 'all 0.2s'
                            }}
                            onMouseEnter={e => e.target.style.transform = 'scale(1.05)'}
                            onMouseLeave={e => e.target.style.transform = 'scale(1)'}
                        >
                            🚀 开发模式（跳过登录）
                        </button>
                    </div>
                )}
            </>
        );
    }

    return <App user={user} token={token} onLogout={handleLogout} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>,
)
