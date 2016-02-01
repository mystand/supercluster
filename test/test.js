'use strict';

var test = require('tap').test;
var supercluster = require('../');

var places = require('./fixtures/places.json');
var placesTile = require('./fixtures/places-z0-0-0.json');

test(function (t) {
    var index = supercluster().load(places.features);
    t.same(index.getTile(0, 0, 0), placesTile);
    t.end();
});

test(function (t) {
    var index = supercluster({collectFeatures: true}).load(places.features);
    index.getClusters([-180, -90, 180, 90], 0).map(function (cluster) {
        if (cluster.properties && cluster.properties.cluster) {
            t.same(cluster.properties.features.length, cluster.properties.point_count);
        }
    });
    t.end();
});
