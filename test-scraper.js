const { fetchNoticias } = require('./engine/noticiasScraper');
(async () => {
  const data = await fetchNoticias();
  console.log('\n=== CAMPAÑAS (' + data.campanas.length + ') ===');
  data.campanas.forEach(function(c, i) {
    console.log('\n[' + i + '] ' + c.title);
    console.log('    body:', c.body);
    console.log('    img: ', c.img ? c.img.split('/').pop().substring(0,50) : '(sin imagen)');
    console.log('    url: ', c.url);
  });
  console.log('\n=== NOTICIAS (' + data.noticias.length + ') ===');
  data.noticias.forEach(function(n, i) {
    console.log('\n[' + i + '] ' + n.title);
    console.log('    body:', n.body);
    console.log('    img: ', n.img ? n.img.split('/').pop().substring(0,50) : '(sin imagen)');
    console.log('    url: ', n.url);
  });
})();
