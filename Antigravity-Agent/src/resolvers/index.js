import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('getText', (req) => {
  console.log(req);
  return 'Calling managed Antigravity Agent...';
});



resolver.define('ACCESS_TOKEN', (req) => {
  return process.env.ACCESS_TOKEN;
});

resolver.define('AGENT_ID', (req) => {
  return process.env.AGENT_ID;
});

export const handler = resolver.getDefinitions();

