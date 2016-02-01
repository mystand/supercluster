'use strict';

var rbush = require('rbush');

module.exports = supercluster;

function supercluster(options) {
    return new SuperCluster(options);
}

function SuperCluster(options) {
    this.options = extend(Object.create(this.options), options);
    this._initTrees();
}

SuperCluster.prototype = {
    options: {
        minZoom: 0,   // min zoom to generate clusters on
        maxZoom: 16,  // max zoom level to cluster the features on
        radius: 40,   // cluster radius in pixels
        extent: 512,  // tile extent (radius is calculated relative to it)
        nodeSize: 16, // size of the R-tree leaf node, affects performance
        log: false    // whether to log timing info
    },

    load: function (features, getCenter) {
        var log = this.options.log;

        if (log) console.time('total time');

        var timerId = 'prepare ' + features.length + ' features';
        if (log) console.time(timerId);

        // generate a cluster object for each feature
        var clusters = features.map(function (f) { return createFeatureCluster(f, getCenter); });
        if (log) console.timeEnd(timerId);

        // cluster features on max zoom, then cluster the results on previous zoom, etc.;
        // results in a cluster hierarchy across zoom levels
        for (var z = this.options.maxZoom; z >= this.options.minZoom; z--) {
            var now = +Date.now();

            this.trees[z + 1].load(clusters); // index input features into an R-tree
            clusters = this._cluster(clusters, z); // create a new set of clusters for the zoom

            if (log) console.log('z%d: %d clusters in %dms', z, clusters.length, +Date.now() - now);
        }
        this.trees[this.options.minZoom].load(clusters); // index top-level clusters

        if (log) console.timeEnd('total time');

        return this;
    },

    getClusters: function (bbox, zoom) {
        var projBBox = [lngX(bbox[0]), latY(bbox[3]), lngX(bbox[2]), latY(bbox[1])];
        var z = Math.max(this.options.minZoom, Math.min(zoom, this.options.maxZoom + 1));
        var clusters = this.trees[z].search(projBBox);
        return clusters.map(getClusterJSON);
    },

    getTile: function (z, x, y) {
        var z2 = Math.pow(2, z);
        var extent = this.options.extent;
        var p = this.options.radius / extent;
        var clusters = this.trees[z].search([
            (x - p) / z2,
            (y - p) / z2,
            (x + 1 + p) / z2,
            (y + 1 + p) / z2
        ]);
        if (!clusters.length) return null;
        var tile = {
            features: []
        };
        for (var i = 0; i < clusters.length; i++) {
            var c = clusters[i];
            var feature = {
                type: 1,
                geometry: [[
                    Math.round(extent * (c.wx * z2 - x)),
                    Math.round(extent * (c.wy * z2 - y))
                ]],
                tags: c.feature ? c.feature.properties : getClusterProperties(c)
            };
            tile.features.push(feature);
        }
        return tile;
    },

    _initTrees: function () {
        this.trees = [];
        // make an R-Tree index for each zoom level
        for (var z = 0; z <= this.options.maxZoom + 1; z++) {
            this.trees[z] = rbush(this.options.nodeSize);
            this.trees[z].toBBox = toBBox;
            this.trees[z].compareMinX = compareMinX;
            this.trees[z].compareMinY = compareMinY;
        }
    },

    _cluster: function (clusters, zoom) {
        var resultClusters = [];
        var r = this.options.radius / (this.options.extent * Math.pow(2, zoom));
        var bbox = [0, 0, 0, 0];

        // loop through each point
        for (var i = 0; i < clusters.length; i++) {
            var c = clusters[i];
            // if we've already visited the point at this zoom level, skip it
            if (c.zoom <= zoom) continue;
            c.zoom = zoom;

            // find all nearby points with a bbox search
            bbox[0] = c.wx - r;
            bbox[1] = c.wy - r;
            bbox[2] = c.wx + r;
            bbox[3] = c.wy + r;
            var bboxNeighbors = this.trees[zoom + 1].search(bbox);

            var foundNeighbors = false;
            var numPoints = c.numPoints;
            var wx = c.wx * numPoints;
            var wy = c.wy * numPoints;

            for (var j = 0; j < bboxNeighbors.length; j++) {
                var b = bboxNeighbors[j];
                // filter out neighbors that are too far or already processed
                if (zoom < b.zoom && distSq(c, b) <= r * r) {
                    foundNeighbors = true;
                    b.zoom = zoom; // save the zoom (so it doesn't get processed twice)
                    wx += b.wx * b.numPoints; // accumulate coordinates for calculating weighted center
                    wy += b.wy * b.numPoints;
                    numPoints += b.numPoints;
                }
            }

            if (!foundNeighbors) {
                resultClusters.push(c); // no neighbors, add a single point as cluster
                continue;
            }

            // form a cluster with neighbors
            var cluster = createCluster(c.x, c.y);
            cluster.numPoints = numPoints;

            // save weighted cluster center for display
            cluster.wx = wx / numPoints;
            cluster.wy = wy / numPoints;

            resultClusters.push(cluster);
        }

        return resultClusters;
    }
};

function toBBox(c) {
    return [c.x, c.y, c.x, c.y];
}
function compareMinX(a, b) {
    return a.x - b.x;
}
function compareMinY(a, b) {
    return a.y - b.y;
}

function createCluster(x, y) {
    return {
        x: x, // cluster center
        y: y,
        wx: x, // weighted cluster center
        wy: y,
        zoom: Infinity, // the last zoom the cluster was processed at
        feature: null,
        numPoints: 1
    };
}

function getCenterForPoint(f) {
    return f.geometry.coordinates;
}

function createFeatureCluster(f, getCenter) {
    if (typeof getCenter !== 'function') {
        getCenter = getCenterForPoint;
    }
    var coords = getCenter(f);
    var cluster = createCluster(lngX(coords[0]), latY(coords[1]));
    cluster.feature = f;
    return cluster;
}

function getClusterJSON(cluster) {
    return cluster.feature ? cluster.feature : {
        type: 'Feature',
        properties: getClusterProperties(cluster),
        geometry: {
            type: 'Point',
            coordinates: [xLng(cluster.wx), yLat(cluster.wy)]
        }
    };
}

function getClusterProperties(cluster) {
    var count = cluster.numPoints;
    var abbrev = count >= 10000 ? Math.round(count / 1000) + 'k' :
                 count >= 1000 ? (Math.round(count / 100) / 10) + 'k' : count;
    return {
        cluster: true,
        point_count: count,
        point_count_abbreviated: abbrev
    };
}

// longitude/latitude to spherical mercator in [0..1] range
function lngX(lng) {
    return lng / 360 + 0.5;
}
function latY(lat) {
    var sin = Math.sin(lat * Math.PI / 180),
        y = (0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI);
    return y < 0 ? 0 :
           y > 1 ? 1 : y;
}

// spherical mercator to longitude/latitude
function xLng(x) {
    return (x - 0.5) * 360;
}
function yLat(y) {
    var y2 = (180 - y * 360) * Math.PI / 180;
    return 360 * Math.atan(Math.exp(y2)) / Math.PI - 90;
}

// squared distance between two points
function distSq(a, b) {
    var dx = a.wx - b.wx;
    var dy = a.wy - b.wy;
    return dx * dx + dy * dy;
}

function extend(dest, src) {
    for (var id in src) dest[id] = src[id];
    return dest;
}
