// =========================================================================
// 1. CONFIGURAÇÕES GERAIS
// =========================================================================

var pastaDrive = 'GEE_Submedio_BA';

var inicioHistorico = '2021-01-01';
var fimHistorico = '2026-01-01';

var anoInicial = 2021;
var anoFinal = 2025;
var anoReferencia = 2025;

var limiarNuvens = 0.60;
var minObservacoes = 5;

var resolucaoRGB = 30;
var resolucaoNDVI = 100;

var crsProjeto = 'EPSG:31984';
var valorNoData = -9999;

// Grades espaciais alinhadas
var grade10m = [10, 0, 0, 0, -10, 0];

var grade100m = [
  resolucaoNDVI, 0, 0,
  0, -resolucaoNDVI, 0
];


// =========================================================================
// 2. RECORTE TERRITORIAL
// =========================================================================

var municipios = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Brazil'))
  .filter(ee.Filter.eq('ADM1_NAME', 'Bahia'))
  .filter(ee.Filter.inList('ADM2_NAME', [
    'Juazeiro',
    'Casa Nova',
    'Curaca',
    'Curaçá',
    'Sobradinho'
  ]));

var roi = municipios.geometry();

// Verificação dos municípios
print('====================================');
print('REGIÃO PILOTO');
print('====================================');

print('Municípios selecionados:',
  municipios.aggregate_array('ADM2_NAME'));

print('Quantidade de municípios:', municipios.size());

print('Área total em km²:',
  roi.area(1).divide(1e6));

Map.centerObject(municipios, 8);


// =========================================================================
// 3. AQUISIÇÃO DAS IMAGENS SENTINEL-2
// =========================================================================

var sentinel2 = ee.ImageCollection(
  'COPERNICUS/S2_SR_HARMONIZED'
)
  .filterBounds(roi)
  .filterDate(inicioHistorico, fimHistorico);

var cloudScore = ee.ImageCollection(
  'GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED'
)
  .filterBounds(roi)
  .filterDate(inicioHistorico, fimHistorico);

print('Total de imagens Sentinel-2:',
  sentinel2.size());


// =========================================================================
// 4. REMOÇÃO DE NUVENS E SOMBRAS
// =========================================================================

var sentinelLimpo = sentinel2
  .linkCollection(cloudScore, ['cs_cdf'])
  .map(function(img) {

    var mascara = img.select('cs_cdf')
      .gte(limiarNuvens);

    return img
      .updateMask(mascara)
      .select(['B2', 'B3', 'B4', 'B8'])
      .copyProperties(img, ['system:time_start']);

  });


// =========================================================================
// 5. IMAGEM RGB - ANO DE REFERÊNCIA
// =========================================================================

var inicioReferencia = ee.Date.fromYMD(
  anoReferencia, 1, 1
);

var fimReferencia = inicioReferencia.advance(
  1, 'year'
);

var imagemRGB = sentinelLimpo
  .filterDate(inicioReferencia, fimReferencia)
  .select(['B4', 'B3', 'B2'])
  .median()
  .clip(roi);

var visRGB = {
  min: 0,
  max: 3000,
  gamma: 1.2
};

Map.addLayer(
  imagemRGB,
  visRGB,
  'Sentinel-2 RGB - 2025'
);


// =========================================================================
// 6. CÁLCULO DO NDVI
// =========================================================================

// NDVI = (NIR - RED) / (NIR + RED)
// Sentinel-2: B8 = NIR | B4 = RED

var colecaoNDVI = sentinelLimpo.map(function(img) {

  var ndvi = img
    .normalizedDifference(['B8', 'B4'])
    .rename('NDVI')
    .toFloat();

  return ndvi.copyProperties(
    img, ['system:time_start']
  );

});

print('Coleção histórica de NDVI:', colecaoNDVI);


// =========================================================================
// 7. CONSTRUÇÃO DO NDVI ANUAL
// =========================================================================

var anos = ee.List.sequence(
  anoInicial, anoFinal
);

var ndviAnual = ee.ImageCollection.fromImages(

  anos.map(function(ano) {

    ano = ee.Number(ano);

    var inicio = ee.Date.fromYMD(ano, 1, 1);
    var fim = inicio.advance(1, 'year');

    var colecaoAno = colecaoNDVI
      .filterDate(inicio, fim);

    // Quantidade de observações válidas
    var observacoesValidas = colecaoAno.count();

    // Mediana temporal anual
    var ndviMediana = colecaoAno
      .median()
      .updateMask(
        observacoesValidas.gte(minObservacoes)
      )
      .clip(roi)
      .rename('NDVI')
      .toFloat();

    // Define a grade de análise inicial de 10 metros
    ndviMediana = ndviMediana.setDefaultProjection(
      crsProjeto,
      grade10m
    );

    // Agregação espacial pela média:
    // pixels de 10 metros para células de 100 metros
    var ndviAgregado = ndviMediana
      .reduceResolution({
        reducer: ee.Reducer.mean(),
        maxPixels: 1024,
        bestEffort: false
      })
      .reproject({
        crs: crsProjeto,
        crsTransform: grade100m
      })
      .clip(roi)
      .rename('NDVI')
      .toFloat();

    return ndviAgregado
      .set('ano', ano)
      .set('system:index', ano.format('%d'))
      .set('system:time_start', inicio.millis())
      .set('quantidade_imagens', colecaoAno.size());

  })

);

print('====================================');
print('SÉRIE HISTÓRICA DE NDVI');
print('====================================');

print('NDVI anual:', ndviAnual);
print('Quantidade de anos:', ndviAnual.size());

print('Anos disponíveis:',
  ndviAnual.aggregate_array('ano'));

print('Quantidade de imagens por ano:',
  ndviAnual.aggregate_array('quantidade_imagens'));


// =========================================================================
// 8. EXTRAÇÃO DO NDVI DE REFERÊNCIA - 2025
// =========================================================================

var ndvi2025 = ee.Image(
  ndviAnual
    .filter(ee.Filter.eq('ano', anoReferencia))
    .first()
);


// =========================================================================
// 9. NDVI MÉDIO HISTÓRICO
// =========================================================================

// Média das medianas anuais entre 2021 e 2025

var ndviMediaHistorica = ndviAnual
  .mean()
  .updateMask(
    ndviAnual.count().eq(anoFinal - anoInicial + 1)
  )
  .rename('NDVI_MEDIA_HISTORICA')
  .setDefaultProjection(crsProjeto, grade100m)
  .clip(roi)
  .toFloat();


// =========================================================================
// 10. VARIABILIDADE INTERANUAL DO NDVI
// =========================================================================

var ndviDesvioPadrao = ndviAnual
  .reduce(ee.Reducer.stdDev())
  .updateMask(
    ndviAnual.count().eq(anoFinal - anoInicial + 1)
  )
  .rename('NDVI_STD_HISTORICO')
  .setDefaultProjection(crsProjeto, grade100m)
  .clip(roi)
  .toFloat();


// =========================================================================
// 11. TENDÊNCIA TEMPORAL DO NDVI
// =========================================================================

// Regressão linear do NDVI em função do ano.
// Resultado: variação estimada de NDVI por ano.

var colecaoTendencia = ndviAnual.map(function(img) {

  var tempo = ee.Image.constant(
    ee.Number(img.get('ano')).subtract(anoInicial)
  )
    .rename('tempo')
    .toFloat()
    .setDefaultProjection(crsProjeto, grade100m)
    .updateMask(img.select('NDVI').mask());

  return tempo.addBands(img.select('NDVI'));

});

var ndviTendencia = colecaoTendencia
  .select(['tempo', 'NDVI'])
  .reduce(ee.Reducer.linearFit())
  .select('scale')
  .updateMask(
    ndviAnual.count().eq(anoFinal - anoInicial + 1)
  )
  .rename('NDVI_TENDENCIA')
  .setDefaultProjection(crsProjeto, grade100m)
  .clip(roi)
  .toFloat();


// =========================================================================
// 12. VISUALIZAÇÃO DAS CAMADAS AMBIENTAIS
// =========================================================================

var visNDVI = {
  min: -0.2,
  max: 0.8,
  palette: [
    '326895',
    'C6AA86',
    'E6D8B5',
    'D4DB82',
    '7BA653',
    '20512C'
  ]
};

var visVariabilidade = {
  min: 0,
  max: 0.2,
  palette: [
    'FFFFCC',
    'FED976',
    'FD8D3C',
    'E31A1C',
    '800026'
  ]
};

var visTendencia = {
  min: -0.05,
  max: 0.05,
  palette: [
    'A50026',
    'F46D43',
    'FFFFBF',
    '66BD63',
    '006837'
  ]
};

Map.addLayer(
  ndvi2025,
  visNDVI,
  'NDVI - 2025',
  false
);

Map.addLayer(
  ndviMediaHistorica,
  visNDVI,
  'NDVI Médio Histórico - 2021 a 2025',
  false
);

Map.addLayer(
  ndviDesvioPadrao,
  visVariabilidade,
  'Variabilidade Interanual do NDVI',
  false
);

Map.addLayer(
  ndviTendencia,
  visTendencia,
  'Tendência Temporal do NDVI',
  false
);

// Limites municipais
Map.addLayer(

  municipios.style({
    color: 'red',
    fillColor: '00000000',
    width: 2
  }),

  {},
  'Limites dos 4 Municípios'

);


// =========================================================================
// 13. CONSTRUÇÃO DO RASTER MULTIBANDA
// =========================================================================

var ndviHistorico = ndviAnual
  .sort('ano')
  .toBands()
  .rename([
    'NDVI_2021',
    'NDVI_2022',
    'NDVI_2023',
    'NDVI_2024',
    'NDVI_2025'
  ])
  .toFloat();


// =========================================================================
// 14. CONSTRUÇÃO DO RASTER DE FEATURES PARA O KNN
// =========================================================================

var featuresNDVI = ndvi2025
  .rename('NDVI_MEDIANA_2025')
  .addBands(ndviMediaHistorica)
  .addBands(ndviDesvioPadrao)
  .addBands(ndviTendencia)
  .toFloat();

print('====================================');
print('CARACTERÍSTICAS AMBIENTAIS');
print('====================================');

print('Bandas do NDVI histórico:',
  ndviHistorico.bandNames());

print('Features de NDVI para o KNN:',
  featuresNDVI.bandNames());

print('Projeção do raster:',
  featuresNDVI.select(0).projection());

print('Resolução espacial:',
  featuresNDVI.select(0)
    .projection().nominalScale());


// =========================================================================
// 15. EXPORTAÇÃO DOS LIMITES EM GEOJSON
// =========================================================================

Export.table.toDrive({

  collection: municipios,

  description: 'Limites_Submedio_SF_GeoJSON',

  folder: pastaDrive,

  fileNamePrefix: 'regiao_piloto',

  fileFormat: 'GeoJSON'

});


// =========================================================================
// 16. EXPORTAÇÃO DA IMAGEM RGB
// =========================================================================

Export.image.toDrive({

  image: imagemRGB.visualize(visRGB),

  description: 'Recorte_RGB_Submedio_SF',

  folder: pastaDrive,

  fileNamePrefix: 'Recorte_RGB_Submedio_SF',

  region: roi,

  scale: resolucaoRGB,

  crs: crsProjeto,

  maxPixels: 1e13,

  fileFormat: 'GeoTIFF',

  formatOptions: {
    cloudOptimized: true
  }

});


// =========================================================================
// 17. EXPORTAÇÃO DO NDVI HISTÓRICO
// =========================================================================

Export.image.toDrive({

  image: ndviHistorico
    .unmask(valorNoData, false),

  description: 'NDVI_Historico_2021_2025',

  folder: pastaDrive,

  fileNamePrefix: 'NDVI_Historico_2021_2025',

  region: roi,

  crs: crsProjeto,

  crsTransform: grade100m,

  maxPixels: 1e13,

  fileFormat: 'GeoTIFF',

  formatOptions: {
    cloudOptimized: true,
    noData: valorNoData
  }

});


// =========================================================================
// 18. EXPORTAÇÃO DAS FEATURES DE NDVI PARA O KNN
// =========================================================================

Export.image.toDrive({

  image: featuresNDVI
    .unmask(valorNoData, false),

  description: 'Features_NDVI_KNN_Submedio_SF',

  folder: pastaDrive,

  fileNamePrefix: 'Features_NDVI_KNN_Submedio_SF',

  region: roi,

  crs: crsProjeto,

  crsTransform: grade100m,

  maxPixels: 1e13,

  fileFormat: 'GeoTIFF',

  formatOptions: {
    cloudOptimized: true,
    noData: valorNoData
  }

});

