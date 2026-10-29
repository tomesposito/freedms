/** Browser settings included in the operator-approved release identity. */
export function releaseConfiguration(env) {
  const config = {apiUrl: env.VITE_API_URL, cognitoDomain: env.VITE_COGNITO_DOMAIN, clientId: env.VITE_COGNITO_CLIENT_ID};
  if (config.apiUrl !== '/api' || !/^https:\/\/[a-z0-9-]+\.auth\.us-east-1\.amazoncognito\.com$/.test(config.cognitoDomain ?? '') || !/^[a-z0-9]+$/.test(config.clientId ?? '')) throw Error('Hosted frontend configuration required');
  if (env.VITE_COGNITO_ENDPOINT) throw Error('Production releases cannot use a Cognito endpoint override');
  if (env.VITE_COGNITO_REGION && env.VITE_COGNITO_REGION !== 'us-east-1') throw Error('Unexpected Cognito region');
  if (env.VITE_AUTH_FLOW && !['inapp', 'redirect'].includes(env.VITE_AUTH_FLOW)) throw Error('Invalid authentication flow');
  if (env.VITE_COGNITO_USER_POOL_ID) {
    if (!/^us-east-1_[A-Za-z0-9]+$/.test(env.VITE_COGNITO_USER_POOL_ID)) throw Error('Invalid Cognito user pool ID');
    config.userPoolId = env.VITE_COGNITO_USER_POOL_ID;
    config.authFlow = env.VITE_AUTH_FLOW || 'inapp';
  } else if (env.VITE_AUTH_FLOW === 'inapp') throw Error('In-app sign-in requires a Cognito user pool ID');
  return config;
}
