import { AuthenticationDetails, CognitoUser, CognitoUserPool, CognitoRefreshToken, type IAuthenticationCallback, type CognitoUserSession } from 'amazon-cognito-identity-js';
export interface Tokens { id: string; refresh: string; access: string }
export interface ChallengeSession { user: CognitoUser; attributes?: Record<string, string>; secretCode?: string }
export type AuthResult = {tokens: Tokens} | {challenge: 'new-password' | 'totp' | 'totp-setup'; session: ChallengeSession};
export interface CognitoConfig { poolId: string; clientId: string; region?: string; endpoint?: string }
export function authError(error: unknown): Error {
  const name = (error as {code?: string; name?: string})?.code || (error as Error)?.name;
  return new Error(['NotAuthorizedException', 'UserNotFoundException'].includes(name) ? 'Email or password is incorrect.' : name === 'CodeMismatchException' ? 'The code is incorrect. Please try again.' : name === 'InvalidPasswordException' ? 'The password does not meet the account password policy.' : 'Sign-in could not be completed. Please try again or contact your pilot operator.');
}
export interface AccountUser { name?: string; email?: string; enabled: boolean }
export interface CognitoUserInfo {
  UserAttributes?: {Name: string; Value: string}[];
  UserMFASettingList?: string[];
  PreferredMfaSetting?: string;
  MFAOptions?: {DeliveryMedium?: string; AttributeName?: string}[];
}
export function accountUser(info: CognitoUserInfo): AccountUser {
  const attributes = Object.fromEntries((info.UserAttributes ?? []).map(a => [a.Name, a.Value]));
  return {name: attributes.name, email: attributes.email, enabled: Boolean(info.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA') || info.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA' || info.MFAOptions?.some(o => o.DeliveryMedium === 'SOFTWARE_TOKEN_MFA'))};
}
export function accountError(error: unknown, operation: string): Error {
  const body = error as {__type?: string; name?: string; message?: string};
  const name = body?.__type?.split('#').pop() || body?.name;
  return new Error(name === 'InvalidPasswordException' && body.message ? body.message : name === 'NotAuthorizedException' && operation === 'ChangePassword' ? 'Current password is incorrect.' : name === 'CodeMismatchException' ? 'The code is incorrect. Please try again.' : 'Account changes could not be completed. Please try again or contact your pilot operator.');
}
export function createCognito(config: CognitoConfig) {
  // The SDK must never persist passwords or its own token cache. auth.ts owns session storage.
  const memory = new Map<string, string>();
  const storage = {setItem: (k: string, v: string) => { memory.set(k, v); }, getItem: (k: string) => memory.get(k) ?? null, removeItem: (k: string) => { memory.delete(k); }, clear: () => memory.clear()};
  const endpoint = config.endpoint || `https://cognito-idp.${config.region || config.poolId.split('_')[0]}.amazonaws.com/`;
  const pool = new CognitoUserPool({UserPoolId: config.poolId, ClientId: config.clientId, Storage: storage, endpoint});
  const user = (Username: string) => new CognitoUser({Username, Pool: pool, Storage: storage});
  const tokens = (s: CognitoUserSession): Tokens => ({id: s.getIdToken().getJwtToken(), refresh: s.getRefreshToken().getToken(), access: s.getAccessToken().getJwtToken()});
  function run(u: CognitoUser, invoke: (callbacks: IAuthenticationCallback) => void): Promise<AuthResult> {
    return new Promise((resolve, reject) => {
      const unsupported = () => reject(new Error('This account requires a sign-in step that is not supported here. Contact your pilot operator or use the hosted sign-in fallback.'));
      invoke({onSuccess: (s: CognitoUserSession) => { const result = tokens(s); storage.clear(); resolve({tokens: result}); }, onFailure: (e: unknown) => reject(authError(e)),
        newPasswordRequired: (attributes: Record<string, string>, required: string[]) => {
          if (required?.length) { unsupported(); return; }
          resolve({challenge: 'new-password', session: {user: u, attributes: {}}});
        }, totpRequired: () => resolve({challenge: 'totp', session: {user: u}}),
        mfaSetup: (_name, parameters) => {
          let methods: unknown;
          try { methods = JSON.parse(parameters?.MFAS_CAN_SETUP ?? '[]'); } catch { unsupported(); return; }
          if (!Array.isArray(methods) || !methods.includes('SOFTWARE_TOKEN_MFA')) { unsupported(); return; }
          u.associateSoftwareToken({associateSecretCode: secretCode => resolve({challenge: 'totp-setup', session: {user: u, secretCode}}), onFailure: e => reject(authError(e))});
        }, mfaRequired: unsupported, selectMFAType: unsupported, customChallenge: unsupported});
    });
  }
  async function accountCall<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    try {
      const response = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${operation}`}, body: JSON.stringify(body)});
      const result = await response.json();
      if (!response.ok) throw result;
      return result as T;
    } catch (error) { throw accountError(error, operation); }
  }
  return {
    getUser: async (accessToken: string) => accountUser(await accountCall<CognitoUserInfo>('GetUser', {AccessToken: accessToken})),
    changePassword: (accessToken: string, previous: string, proposed: string) => accountCall<void>('ChangePassword', {AccessToken: accessToken, PreviousPassword: previous, ProposedPassword: proposed}),
    associateSoftwareToken: async (accessToken: string) => {
      const result = await accountCall<{SecretCode?: string}>('AssociateSoftwareToken', {AccessToken: accessToken});
      if (!result.SecretCode) throw accountError({}, 'AssociateSoftwareToken');
      return result.SecretCode;
    },
    verifySoftwareToken: async (accessToken: string, code: string) => {
      const result = await accountCall<{Status: string}>('VerifySoftwareToken', {AccessToken: accessToken, UserCode: code, FriendlyDeviceName: 'freeDMS authenticator'});
      if (result.Status !== 'SUCCESS') throw accountError({}, 'VerifySoftwareToken');
    },
    setTotpPreference: (accessToken: string, enabled: boolean) => accountCall<void>('SetUserMFAPreference', {AccessToken: accessToken, SoftwareTokenMfaSettings: {Enabled: enabled, PreferredMfa: enabled}}),
    signIn: (username: string, password: string) => { const u = user(username); u.setAuthenticationFlowType('USER_SRP_AUTH'); return run(u, cb => u.authenticateUser(new AuthenticationDetails({Username: username, Password: password}), cb)); },
    respondNewPassword: (s: ChallengeSession, password: string) => run(s.user, cb => s.user.completeNewPasswordChallenge(password, s.attributes || {}, cb)),
    respondTotp: (s: ChallengeSession, code: string) => run(s.user, cb => s.user.sendMFACode(code, cb, 'SOFTWARE_TOKEN_MFA')),
    completeTotpSetup: (s: ChallengeSession, code: string) => run(s.user, cb => s.user.verifySoftwareToken(code, 'freeDMS authenticator', cb)),
    forgotPassword: (username: string): Promise<void> => new Promise((resolve, reject) => user(username).forgotPassword({onSuccess: () => resolve(), inputVerificationCode: () => resolve(), onFailure: e => reject(authError(e))})),
    confirmForgotPassword: (username: string, code: string, password: string): Promise<void> => new Promise((resolve, reject) => user(username).confirmPassword(code, password, {onSuccess: () => resolve(), onFailure: e => reject(authError(e))})),
    refresh: (refresh: string): Promise<Tokens> => new Promise((resolve, reject) => user('').refreshSession(new CognitoRefreshToken({RefreshToken: refresh}), (e, s) => { storage.clear(); e ? reject(authError(e)) : resolve({...tokens(s), refresh}); })),
    revoke: async (refresh: string) => { const response = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.RevokeToken'}, body: JSON.stringify({ClientId: config.clientId, Token: refresh})}); if (!response.ok) throw new Error('Revocation failed.'); }
  };
}
export type Cognito = ReturnType<typeof createCognito>;
