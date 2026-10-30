// Offline protocol fixture only: does not validate SRP proofs or provide real authentication.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
export function mockCognito(port = 9229) {
  const calls = [];
  let serial = 0;
  let mfaEnabled = false;
  let associated = false;
  let verified = false;
  let password = 'FixturePassword123!';
  const jwt = kind => [Buffer.from(JSON.stringify({alg:'none'})).toString('base64url'), Buffer.from(JSON.stringify({sub:'offline-user', email:'pilot@example.test', token_use:kind, exp: Math.floor(Date.now()/1000)+3600, iat:Math.floor(Date.now()/1000), serial:++serial})).toString('base64url'), 'offline'].join('.');
  const tokens = () => ({IdToken:jwt('id'), AccessToken:jwt('access'), RefreshToken:'offline-refresh', ExpiresIn:3600, TokenType:'Bearer'});
  const server = createServer(async (req,res) => {
    res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*');
    if(req.method === 'OPTIONS') {res.end();return;}
    let raw=''; for await (const chunk of req) raw += chunk;
    const body=JSON.parse(raw || '{}'); const operation=String(req.headers['x-amz-target']).split('.').pop(); calls.push(operation);
    res.setHeader('Content-Type','application/x-amz-json-1.1');
    const send = data => res.end(JSON.stringify(data));
    const fail = (type, message = 'Offline fixture rejection') => {res.statusCode=400;send({__type:type,message});};
    if (body.AccessToken) {
      if (operation === 'GetUser') return send({Username:'pilot@example.test', UserAttributes:[{Name:'name',Value:'Pilot User'},{Name:'email',Value:'pilot@example.test'}], UserMFASettingList:mfaEnabled ? ['SOFTWARE_TOKEN_MFA'] : []});
      if (operation === 'ChangePassword') {
        if (body.PreviousPassword !== password) return fail('NotAuthorizedException');
        if (body.ProposedPassword.length < 12) return fail('InvalidPasswordException', 'Password must have length greater than or equal to 12');
        password = body.ProposedPassword; return send({});
      }
      if (operation === 'AssociateSoftwareToken') { associated = true; verified = false; return send({SecretCode:'JBSWY3DPEHPK3PXP'}); }
      if (operation === 'VerifySoftwareToken') {
        if (!associated) return fail('NotAuthorizedException');
        if (body.UserCode !== '123456') return fail('CodeMismatchException');
        if (body.FriendlyDeviceName !== 'freeDMS authenticator') return fail('InvalidParameterException');
        verified = true; return send({Status:'SUCCESS'});
      }
      if (operation === 'SetUserMFAPreference') {
        if (!verified) return fail('NotAuthorizedException');
        mfaEnabled = body.SoftwareTokenMfaSettings.Enabled; return send({});
      }
    }
    if(operation==='InitiateAuth') {
      if(body.AuthFlow==='REFRESH_TOKEN_AUTH') return send({AuthenticationResult:tokens()});
      if(body.AuthFlow!=='USER_SRP_AUTH') return fail('InvalidParameterException');
      const username=body.AuthParameters.USERNAME;
      return send({ChallengeName:'PASSWORD_VERIFIER', Session:username, ChallengeParameters:{USER_ID_FOR_SRP:username, USERNAME:username, SRP_B:'b'.repeat(768), SALT:'abc123', SECRET_BLOCK:Buffer.alloc(16,1).toString('base64')}});
    }
    if(operation==='RespondToAuthChallenge') {
      const username=body.ChallengeResponses.USERNAME;
      // Rejection fixture represents a failed password proof; no passwords cross SRP's wire.
      if(username.startsWith('wrong') || username.startsWith('unknown')) return fail(username.startsWith('unknown')?'UserNotFoundException':'NotAuthorizedException');
      if(body.ChallengeName==='PASSWORD_VERIFIER') {
        if(username.startsWith('newpass')) return send({ChallengeName:'NEW_PASSWORD_REQUIRED',Session:username,ChallengeParameters:{userAttributes:JSON.stringify({email:username}),requiredAttributes:'[]'}});
        if(username.startsWith('totp')) return send({ChallengeName:'SOFTWARE_TOKEN_MFA',Session:username,ChallengeParameters:{}});
        if(username.startsWith('setup')) return send({ChallengeName:'MFA_SETUP',Session:username,ChallengeParameters:{MFAS_CAN_SETUP:'["SOFTWARE_TOKEN_MFA"]'}});
        if(username.startsWith('unsupported')) return send({ChallengeName:'MFA_SETUP',Session:username,ChallengeParameters:{MFAS_CAN_SETUP:'["SMS_MFA"]'}});
      }
      if(body.ChallengeName==='NEW_PASSWORD_REQUIRED' && username.startsWith('newpasssetup')) return send({ChallengeName:'MFA_SETUP',Session:username,ChallengeParameters:{MFAS_CAN_SETUP:'["SOFTWARE_TOKEN_MFA"]'}});
      if(body.ChallengeName==='SOFTWARE_TOKEN_MFA' && body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE!=='123456') return fail('CodeMismatchException');
      if(body.ChallengeName==='MFA_SETUP' && body.Session!=='verified:'+username) return fail('NotAuthorizedException');
      return send({AuthenticationResult:tokens()});
    }
    if(operation==='AssociateSoftwareToken') return send({SecretCode:'JBSWY3DPEHPK3PXP',Session:'associated:'+body.Session});
    if(operation==='VerifySoftwareToken') {
      if(body.UserCode!=='123456') return fail('CodeMismatchException');
      if(!body.Session?.startsWith('associated:')) return fail('NotAuthorizedException');
      return send({Status:'SUCCESS',Session:'verified:'+body.Session.slice('associated:'.length)});
    }
    if(operation==='ForgotPassword') return send({CodeDeliveryDetails:{DeliveryMedium:'EMAIL'}});
    if(operation==='ConfirmForgotPassword' && body.ConfirmationCode!=='123456') return fail('CodeMismatchException');
    if(['ConfirmForgotPassword','RevokeToken'].includes(operation)) return send({});
    fail('InvalidParameterException');
  });
  return new Promise(resolve => server.listen(port,'127.0.0.1',()=>resolve({server,calls,endpoint:`http://127.0.0.1:${server.address().port}`})));
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {await mockCognito();console.log('Offline Cognito fixture on http://127.0.0.1:9229');}
