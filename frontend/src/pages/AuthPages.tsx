import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { user, login, signup } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  if (user !== null) return <Navigate to="/wallet" replace />;

  const isSignup = mode === 'signup';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSubmitting(true);

    try {
      await (isSignup ? signup(email, password) : login(email, password));
      navigate('/wallet');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        // Per-field messages from the API: the difference between "signup
        // failed" and "password must be 8-64 characters".
        setFieldErrors(caught.details.map((detail) => detail.message));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card card--auth">
      <div className="card__header">
        <div>
          <h1>{isSignup ? 'Create an account' : 'Welcome back'}</h1>
          <p className="card__subtitle">
            {isSignup
              ? 'Sign up to buy credits and fund campaigns.'
              : 'Log in to view your balances and fund campaigns.'}
          </p>
        </div>
      </div>

      <div className="card__body">
        <form className="stack stack--sm" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              required
            />
            {isSignup && (
              <span className="field__hint">
                8–64 characters. Letters, numbers and special characters — no spaces.
              </span>
            )}
          </div>

          {error !== null && (
            <div className="alert alert--error">
              <strong>{error}</strong>
              {fieldErrors.length > 0 && (
                <ul>
                  {fieldErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? 'Working…' : isSignup ? 'Create account' : 'Log in'}
          </button>
        </form>

        <p className="muted" style={{ marginTop: '1rem', textAlign: 'center' }}>
          {isSignup ? (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          ) : (
            <>
              Need an account? <Link to="/signup">Sign up</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export const LoginPage = () => <AuthForm mode="login" />;
export const SignupPage = () => <AuthForm mode="signup" />;
