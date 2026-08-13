const db = require('better-sqlite3')('../data/its.db');
const rows = db.prepare('SELECT c.nombre as carrera, m.nombre as materia, m.anio FROM materias m JOIN carreras c ON c.id=m.carrera_id ORDER BY c.nombre, m.anio, m.nombre').all();
db.close();

const por = {};
for(const r of rows){
  if(!por[r.carrera]) por[r.carrera]={1:[],2:[],3:[]};
  if(!por[r.carrera][r.anio]) por[r.carrera][r.anio]=[];
  por[r.carrera][r.anio].push(r.materia);
}

for(const [car, anios] of Object.entries(por)){
  console.log('\n=== '+car.toUpperCase()+' ===');
  for(const a of [1,2,3]){
    if(anios[a]&&anios[a].length){
      console.log('  '+a+'° Año:');
      anios[a].forEach(m=>console.log('    - '+m));
    }
  }
}
