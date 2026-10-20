const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('parsed_excel.json', 'utf8'));

const servers = rawData.map((row, index) => {
  const name = row.hostname.split('.')[0].toUpperCase();
  // infer some mock data based on the hostname string
  let env = 'Production';
  if (name.includes('DEV') || name.startsWith('C04D')) env = 'Development';
  if (name.includes('UAT') || name.startsWith('C04Q')) env = 'UAT';
  
  let group = 'Web Servers';
  if (name.includes('SQL') || name.includes('DB')) group = 'DB Servers';
  else if (name.includes('APP')) group = 'App Servers';
  else if (name.includes('DC')) group = 'Domain Controllers';
  
  return {
    id: `SVR-${(index + 1).toString().padStart(3, '0')}`,
    name: name,
    ip: `10.120.${Math.floor(Math.random() * 5 + 1)}.${Math.floor(Math.random() * 250 + 1)}`,
    os: Math.random() > 0.5 ? 'Windows Server 2022' : 'Windows Server 2019',
    environment: env,
    group: group,
    lastPatched: '2026-04-15',
    status: Math.random() > 0.9 ? 'offline' : 'online',
    criticalUpdates: Math.floor(Math.random() * 5),
    location: 'US-East'
  };
});

const fileContent = `// Auto-generated from server-list-perfroming-pre-and-post.xlsx

const servers = ${JSON.stringify(servers, null, 2)};

export default servers;

export const environments = [...new Set(servers.map(s => s.environment))];
export const groups = [...new Set(servers.map(s => s.group))];
export const osVersions = [...new Set(servers.map(s => s.os))];
export const locations = [...new Set(servers.map(s => s.location))];
export const statuses = [...new Set(servers.map(s => s.status))];
`;

fs.writeFileSync('src/data/servers.js', fileContent);
console.log('Successfully updated src/data/servers.js with', servers.length, 'servers.');
