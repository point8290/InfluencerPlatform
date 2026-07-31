import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { WalletPage } from './pages/WalletPage';
import { CampaignsPage } from './pages/CampaignsPage';

/**
 * Client-side route protection is a UX affordance, not a security control —
 * every protected endpoint independently requires a valid JWT and scopes its
 * query to that user's id. Deleting this component would make the app ugly,
 * not insecure.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth();
  const location = useLocation();

  if (initialising) {
    return (
      <div className="stack stack--sm" aria-busy="true" aria-label="Loading">
        <div className="skeleton" style={{ height: '4rem' }} />
        <div className="skeleton" style={{ height: '12rem' }} />
      </div>
    );
  }

  if (user === null) return <Navigate to="/login" state={{ from: location }} replace />;

  return <>{children}</>;
}

function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            ₹
          </span>
          <span>Credits Wallet</span>
        </div>

        {user !== null && (
          <>
            <nav className="nav">
              <NavLink to="/wallet" className={({ isActive }) => (isActive ? 'is-active' : '')}>
                Wallet
              </NavLink>
              <NavLink to="/campaigns" className={({ isActive }) => (isActive ? 'is-active' : '')}>
                Campaigns
              </NavLink>
            </nav>

            <div className="cluster">
              <span className="subtle">{user.email}</span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={logout}>
                Log out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Header />
        <main className="container">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route
              path="/wallet"
              element={
                <RequireAuth>
                  <WalletPage />
                </RequireAuth>
              }
            />
            <Route
              path="/campaigns"
              element={
                <RequireAuth>
                  <CampaignsPage />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/wallet" replace />} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  );
}
