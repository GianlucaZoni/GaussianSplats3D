import * as THREE from 'three';
import { UncompressedSplatArray } from './UncompressedSplatArray.js';
import { clamp, getSphericalHarmonicsComponentCountForDegree } from '../Util.js';

/**
 * SplatBuffer: Container for splat data from a single scene/file and capable of (mediocre) compression.
 */
export class SplatBuffer {

    static CurrentMajorVersion = 0;
    static CurrentMinorVersion = 1;

    static CenterComponentCount = 3;
    static ScaleComponentCount = 3;
    static RotationComponentCount = 4;
    static ColorComponentCount = 4;
    static CovarianceComponentCount = 6;

    static SplatScaleOffsetFloat = 3;
    static SplatRotationOffsetFloat = 6;

    static CompressionLevels = {
        0: {
            BytesPerCenter: 12,
            BytesPerColor: 4,
            BytesPerScale: 12,
            BytesPerRotation: 16,
            ScaleRange: 1,
            BytesPerSphericalHarmonicsComponent: 4,
            SphericalHarmonicsOffsetFloat: 11,
            SphericalHarmonicsDegrees: {
                0: {
                    BytesPerSplat: 44
                },
                1: {
                    BytesPerSplat: 80,
                },
                2: {
                    BytesPerSplat: 140,
                }
            },
        },
        1: {
            BytesPerCenter: 6,
            BytesPerColor: 4,
            BytesPerScale: 6,
            BytesPerRotation: 8,
            ScaleRange: 32767,
            BytesPerSphericalHarmonicsComponent: 2,
            SphericalHarmonicsOffsetFloat: 12,
            SphericalHarmonicsDegrees: {
                0: {
                    BytesPerSplat: 24,
                },
                1: {
                    BytesPerSplat: 42,
                },
                2: {
                    BytesPerSplat: 72,
                }
            },
        }
    };

    static CovarianceSizeFloats = 6;

    static HeaderSizeBytes = 4096;
    static SectionHeaderSizeBytes = 1024;

    static BucketStorageSizeBytes = 12;
    static BucketStorageSizeFloats = 3;

    static BucketBlockSize = 5.0;
    static BucketSize = 256;

    constructor(bufferData, secLoadedCountsToMax = true) {
        this.constructFromBuffer(bufferData, secLoadedCountsToMax);
    }

    fbf(f) {
        if (this.compressionLevel === 0) {
            return f;
        } else {
            return THREE.DataUtils.fromHalfFloat(f);
        }
    };

    fbfV3(v, o) {
        if (this.compressionLevel === 1) {
            o.x = this.fbf(v.x);
            o.y = this.fbf(v.y);
            o.z = this.fbf(v.z);
        } else {
            o.copy(v);
        }
        return o;
    };

    fbfA3(v, o) {
        if (this.compressionLevel === 1) {
            o[0] = this.fbf(v[0]);
            o[1] = this.fbf(v[1]);
            o[2] = this.fbf(v[2]);
        } else {
            o[0] = v[0];
            o[1] = v[1];
            o[2] = v[2];
        }
        return o;
    };

    getSplatCount() {
        return this.splatCount;
    }

    getMaxSplatCount() {
        return this.maxSplatCount;
    }

    getBucketIndex(section, localSplatIndex) {
        let bucketIndex;
        const maxSplatIndexInFullBuckets = section.fullBucketCount * section.bucketSize;
        if (localSplatIndex < maxSplatIndexInFullBuckets) {
            bucketIndex = Math.floor(localSplatIndex / section.bucketSize);
        } else {
            let bucketSplatIndex = maxSplatIndexInFullBuckets;
            bucketIndex = section.fullBucketCount;
            let partiallyFullBucketIndex = 0;
            while (bucketSplatIndex < section.splatCount) {
                let currentPartiallyFilledBucketSize = section.partiallyFilledBucketLengths[partiallyFullBucketIndex];
                if (localSplatIndex >= bucketSplatIndex && localSplatIndex < bucketSplatIndex + currentPartiallyFilledBucketSize) {
                    break;
                }
                bucketSplatIndex += currentPartiallyFilledBucketSize;
                bucketIndex++;
                partiallyFullBucketIndex++;
            }
        }
        return bucketIndex;
    }

    getSplatCenter(globalSplatIndex, outCenter, transform) {
        const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
        const section = this.sections[sectionIndex];
        const localSplatIndex = globalSplatIndex - section.splatCountOffset;
        if (this.compressionLevel === 1) {
            const centerBase = localSplatIndex * this.uint16PerSplat;
            const bucketIndex = this.getBucketIndex(section, localSplatIndex);
            const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
            const sf = section.compressionScaleFactor;
            const sr = section.compressionScaleRange;
            outCenter.x = (section.dataArrayUint16[centerBase] - sr) * sf + section.bucketArray[bucketBase];
            outCenter.y = (section.dataArrayUint16[centerBase + 1] - sr) * sf + section.bucketArray[bucketBase + 1];
            outCenter.z = (section.dataArrayUint16[centerBase + 2] - sr) * sf + section.bucketArray[bucketBase + 2];
        } else {
            const centerBase = localSplatIndex * this.float32PerSplat;
            outCenter.x = section.dataArrayFloat32[centerBase];
            outCenter.y = section.dataArrayFloat32[centerBase + 1];
            outCenter.z = section.dataArrayFloat32[centerBase + 2];
        }
        if (transform) outCenter.applyMatrix4(transform);
    }

    getSplatScaleAndRotation = function() {

        const scaleMatrix = new THREE.Matrix4();
        const rotationMatrix = new THREE.Matrix4();
        const tempMatrix = new THREE.Matrix4();
        const tempPosition = new THREE.Vector3();

        return function(index, outScale, outRotation, transform) {
            const sectionIndex = this.globalSplatIndexToSectionMap[index];
            const section = this.sections[sectionIndex];
            const localSplatIndex = index - section.splatCountOffset;

            const floatsPerSplat = this.compressionLevel === 1 ? this.uint16PerSplat : this.float32PerSplat;

            const sectionFloatArray = this.compressionLevel === 1 ? section.dataArrayUint16 : section.dataArrayFloat32;
            const splatFloatBase = floatsPerSplat * localSplatIndex;

            const scaleBase = splatFloatBase + SplatBuffer.SplatScaleOffsetFloat;
            outScale.set(this.fbf(sectionFloatArray[scaleBase]),
                         this.fbf(sectionFloatArray[scaleBase + 1]),
                         this.fbf(sectionFloatArray[scaleBase + 2]));

            const rotationBase = splatFloatBase + SplatBuffer.SplatRotationOffsetFloat;
            outRotation.set(this.fbf(sectionFloatArray[rotationBase + 1]),
                            this.fbf(sectionFloatArray[rotationBase + 2]),
                            this.fbf(sectionFloatArray[rotationBase + 3]),
                            this.fbf(sectionFloatArray[rotationBase]));

            if (transform) {
                scaleMatrix.makeScale(outScale.x, outScale.y, outScale.z);
                rotationMatrix.makeRotationFromQuaternion(outRotation);
                tempMatrix.copy(scaleMatrix).multiply(rotationMatrix).multiply(transform);
                tempMatrix.decompose(tempPosition, outRotation, outScale);
            }
        };

    }();

    getSplatColor(globalSplatIndex, outColor, transform) {
        const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
        const section = this.sections[sectionIndex];
        const localSplatIndex = globalSplatIndex - section.splatCountOffset;
        const colorBase = this.bytesPerSplat * localSplatIndex + this.bytesPerCenter + this.bytesPerScale + this.bytesPerRotation;
        outColor.set(section.dataArrayUint8[colorBase], section.dataArrayUint8[colorBase + 1],
                     section.dataArrayUint8[colorBase + 2], section.dataArrayUint8[colorBase + 3]);
    }

    fillSplatCenterArray(outCenterArray, transform, srcFrom, srcTo, destFrom) {
        const splatCount = this.splatCount;

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;

        const center = new THREE.Vector3();
        for (let i = srcFrom; i <= srcTo; i++) {
            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;
            const centerDestBase = (i - srcFrom + destFrom) * SplatBuffer.CenterComponentCount;
            if (this.compressionLevel === 1) {
                const centerBase = localSplatIndex * this.uint16PerSplat;
                const bucketIndex = this.getBucketIndex(section, localSplatIndex);
                const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
                const sf = section.compressionScaleFactor;
                const sr = section.compressionScaleRange;
                center.x = (section.dataArrayUint16[centerBase] - sr) * sf + section.bucketArray[bucketBase];
                center.y = (section.dataArrayUint16[centerBase + 1] - sr) * sf + section.bucketArray[bucketBase + 1];
                center.z = (section.dataArrayUint16[centerBase + 2] - sr) * sf + section.bucketArray[bucketBase + 2];
            } else {
                const centerBase = localSplatIndex * this.float32PerSplat;
                center.x = section.dataArrayFloat32[centerBase];
                center.y = section.dataArrayFloat32[centerBase + 1];
                center.z = section.dataArrayFloat32[centerBase + 2];
            }
            if (transform) {
                center.applyMatrix4(transform);
            }
            outCenterArray[centerDestBase] = center.x;
            outCenterArray[centerDestBase + 1] = center.y;
            outCenterArray[centerDestBase + 2] = center.z;
        }
    }

    static computeCovariance = function() {

        const tempMatrix4 = new THREE.Matrix4();
        const scaleMatrix = new THREE.Matrix3();
        const rotationMatrix = new THREE.Matrix3();
        const covarianceMatrix = new THREE.Matrix3();
        const transformedCovariance = new THREE.Matrix3();
        const transform3x3 = new THREE.Matrix3();
        const transform3x3Transpose = new THREE.Matrix3();
        const thf = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);

        return function(scale, rotation, transform, outCovariance, outOffset = 0, desiredOutputCompressionLevel) {

            tempMatrix4.makeScale(scale.x, scale.y, scale.z);
            scaleMatrix.setFromMatrix4(tempMatrix4);

            tempMatrix4.makeRotationFromQuaternion(rotation);
            rotationMatrix.setFromMatrix4(tempMatrix4);

            covarianceMatrix.copy(rotationMatrix).multiply(scaleMatrix);
            transformedCovariance.copy(covarianceMatrix).transpose().premultiply(covarianceMatrix);

            if (transform) {
                transform3x3.setFromMatrix4(transform);
                transform3x3Transpose.copy(transform3x3).transpose();
                transformedCovariance.multiply(transform3x3Transpose);
                transformedCovariance.premultiply(transform3x3);
            }

            if (desiredOutputCompressionLevel === 1) {
                outCovariance[outOffset] = thf(transformedCovariance.elements[0]);
                outCovariance[outOffset + 1] = thf(transformedCovariance.elements[3]);
                outCovariance[outOffset + 2] = thf(transformedCovariance.elements[6]);
                outCovariance[outOffset + 3] = thf(transformedCovariance.elements[4]);
                outCovariance[outOffset + 4] = thf(transformedCovariance.elements[7]);
                outCovariance[outOffset + 5] = thf(transformedCovariance.elements[8]);
            } else {
                outCovariance[outOffset] = transformedCovariance.elements[0];
                outCovariance[outOffset + 1] = transformedCovariance.elements[3];
                outCovariance[outOffset + 2] = transformedCovariance.elements[6];
                outCovariance[outOffset + 3] = transformedCovariance.elements[4];
                outCovariance[outOffset + 4] = transformedCovariance.elements[7];
                outCovariance[outOffset + 5] = transformedCovariance.elements[8];
            }

        };

    }();

    fillSplatCovarianceArray(covarianceArray, transform, srcFrom, srcTo, destFrom, desiredOutputCompressionLevel) {
        const splatCount = this.splatCount;

        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;
        const floatsPerSplat = this.compressionLevel === 1 ? this.uint16PerSplat : this.float32PerSplat;

        for (let i = srcFrom; i <= srcTo; i++) {
            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;

            const sectionFloatArray = this.compressionLevel === 1 ? section.dataArrayUint16 : section.dataArrayFloat32;
            const splatFloatBase = floatsPerSplat * localSplatIndex;
            const covarianceDestBase = (i - srcFrom + destFrom) * SplatBuffer.CovarianceComponentCount;

            const scaleBase = splatFloatBase + SplatBuffer.SplatScaleOffsetFloat;
            scale.set(this.fbf(sectionFloatArray[scaleBase]),
                      this.fbf(sectionFloatArray[scaleBase + 1]),
                      this.fbf(sectionFloatArray[scaleBase + 2]));

            const rotationBase = splatFloatBase + SplatBuffer.SplatRotationOffsetFloat;
            rotation.set(this.fbf(sectionFloatArray[rotationBase + 1]),
                         this.fbf(sectionFloatArray[rotationBase + 2]),
                         this.fbf(sectionFloatArray[rotationBase + 3]),
                         this.fbf(sectionFloatArray[rotationBase]));

            SplatBuffer.computeCovariance(scale, rotation, transform, covarianceArray, covarianceDestBase, desiredOutputCompressionLevel);
        }
    }

    fillSplatColorArray(outColorArray, minimumAlpha, transform, srcFrom, srcTo, destFrom) {
        const splatCount = this.splatCount;

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;
        const splatColorOffset = this.bytesPerCenter + this.bytesPerScale + this.bytesPerRotation;

        for (let i = srcFrom; i <= srcTo; i++) {

            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;

            const colorSrcBase = this.bytesPerSplat * localSplatIndex + splatColorOffset;
            const colorDestBase = (i - srcFrom + destFrom) * SplatBuffer.ColorComponentCount;

            let alpha = section.dataArrayUint8[colorSrcBase + 3];
            alpha = (alpha >= minimumAlpha) ? alpha : 0;

            outColorArray[colorDestBase] = section.dataArrayUint8[colorSrcBase];
            outColorArray[colorDestBase + 1] = section.dataArrayUint8[colorSrcBase + 1];
            outColorArray[colorDestBase + 2] = section.dataArrayUint8[colorSrcBase + 2];
            outColorArray[colorDestBase + 3] = alpha;
        }
    }

    fillSphericalHarmonicsArray = function() {

        const sphericalHarmonicVectors = [];
        for (let i = 0; i < 15; i++) {
            sphericalHarmonicVectors[i] = new THREE.Vector3();
        }

        const tempMatrix3 = new THREE.Matrix3();

        const sh11 = [];
        const sh12 = [];
        const sh13 = [];

        const sh21 = [];
        const sh22 = [];
        const sh23 = [];
        const sh24 = [];
        const sh25 = [];

        const shIn1 = [];
        const shIn2 = [];
        const shIn3 = [];
        const shIn4 = [];
        const shIn5 = [];

        const shOut1 = [];
        const shOut2 = [];
        const shOut3 = [];
        const shOut4 = [];
        const shOut5 = [];

        const thf = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);
        const fbf = THREE.DataUtils.fromHalfFloat.bind(THREE.DataUtils);
        const noop = (v) => v;

        const dot3 = (v1, v2, v3, transformRow, outArray) => {
            outArray[0] = outArray[1] = outArray[2] = 0;
            const t0 = transformRow[0];
            const t1 = transformRow[1];
            const t2 = transformRow[2];
            addInto3(v1[0] * t0, v1[1] * t0, v1[2] * t0, outArray);
            addInto3(v2[0] * t1, v2[1] * t1, v2[2] * t1, outArray);
            addInto3(v3[0] * t2, v3[1] * t2, v3[2] * t2, outArray);
        };

        const set3 = (array, val1, val2, val3) => {
            array[0] = val1;
            array[1] = val2;
            array[2] = val3;
        };

        const addInto3 = (val1, val2, val3, destArray) => {
            destArray[0] = destArray[0] + val1;
            destArray[1] = destArray[1] + val2;
            destArray[2] = destArray[2] + val3;
        };

        const copy3 = (srcArray, destArray) => {
            destArray[0] = srcArray[0];
            destArray[1] = srcArray[1];
            destArray[2] = srcArray[2];
        };

        const dot5 = (v1, v2, v3, v4, v5, transformRow, outArray) => {
            outArray[0] = outArray[1] = outArray[2] = 0;
            const t0 = transformRow[0];
            const t1 = transformRow[1];
            const t2 = transformRow[2];
            const t3 = transformRow[3];
            const t4 = transformRow[4];
            addInto3(v1[0] * t0, v1[1] * t0, v1[2] * t0, outArray);
            addInto3(v2[0] * t1, v2[1] * t1, v2[2] * t1, outArray);
            addInto3(v3[0] * t2, v3[1] * t2, v3[2] * t2, outArray);
            addInto3(v4[0] * t3, v4[1] * t3, v4[2] * t3, outArray);
            addInto3(v5[0] * t4, v5[1] * t4, v5[2] * t4, outArray);
        };

        const kSqrt0104 = Math.sqrt(1.0 / 4.0);
        const kSqrt0304 = Math.sqrt(3.0 / 4.0);
        const kSqrt0103 = Math.sqrt(1.0 / 3.0);
        const kSqrt0403 = Math.sqrt(4.0 / 3.0);
        const kSqrt0112 = Math.sqrt(1.0 / 12.0);

        return function(outSphericalHarmonicsArray, outSphericalHarmonicsDegree, transform,
                        srcFrom, srcTo, destFrom, desiredOutputCompressionLevel) {
            const splatCount = this.splatCount;

            srcFrom = srcFrom || 0;
            srcTo = srcTo || splatCount - 1;
            if (destFrom === undefined) destFrom = srcFrom;
            const floatsPerSplat = this.compressionLevel === 1 ? this.uint16PerSplat : this.float32PerSplat;

            if (transform && outSphericalHarmonicsDegree >= 1) {
                tempMatrix3.setFromMatrix4(transform);
                set3(sh11, tempMatrix3.elements[4], -tempMatrix3.elements[7], tempMatrix3.elements[1]);
                set3(sh12, -tempMatrix3.elements[5], tempMatrix3.elements[8], -tempMatrix3.elements[2]);
                set3(sh13, tempMatrix3.elements[3], -tempMatrix3.elements[6], tempMatrix3.elements[0]);
            }

            outSphericalHarmonicsDegree = Math.min(outSphericalHarmonicsDegree, this.sphericalHarmonicsDegree);
            const outSphericalHarmonicsComponentsCount = getSphericalHarmonicsComponentCountForDegree(outSphericalHarmonicsDegree);

            for (let i = srcFrom; i <= srcTo; i++) {

                const sectionIndex = this.globalSplatIndexToSectionMap[i];
                const section = this.sections[sectionIndex];
                const localSplatIndex = i - section.splatCountOffset;

                const sphericalHarmonicsOffsetFloat = SplatBuffer.CompressionLevels[this.compressionLevel].SphericalHarmonicsOffsetFloat;
                const sphericalHarmonicsSrcBase = floatsPerSplat * localSplatIndex + sphericalHarmonicsOffsetFloat;
                const shDestBase = (i - srcFrom + destFrom) * outSphericalHarmonicsComponentsCount;

                if (outSphericalHarmonicsDegree >= 1) {
                    const sectionFloatArray = this.compressionLevel === 1 ? section.dataArrayUint16 : section.dataArrayFloat32;

                    let srcCompressionLevel = this.compressionLevel;

                    set3(shIn1, sectionFloatArray[sphericalHarmonicsSrcBase],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 3],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 6]);

                    set3(shIn2, sectionFloatArray[sphericalHarmonicsSrcBase + 1],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 4],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 7]);

                    set3(shIn3, sectionFloatArray[sphericalHarmonicsSrcBase + 2],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 5],
                                 sectionFloatArray[sphericalHarmonicsSrcBase + 8]);

                    if (transform) {
                        this.fbfA3(shIn1, shIn1);
                        this.fbfA3(shIn2, shIn2);
                        this.fbfA3(shIn3, shIn3);

                        srcCompressionLevel = 0;

                        dot3(shIn1, shIn2, shIn3, sh11, shOut1);
                        dot3(shIn1, shIn2, shIn3, sh12, shOut2);
                        dot3(shIn1, shIn2, shIn3, sh13, shOut3);
                    } else {
                        copy3(shIn1, shOut1);
                        copy3(shIn2, shOut2);
                        copy3(shIn3, shOut3);
                    }

                    let conversionFunc = noop;
                    if (srcCompressionLevel !== desiredOutputCompressionLevel) {
                        if (srcCompressionLevel === 1) {
                            if (desiredOutputCompressionLevel === 0) conversionFunc = fbf;
                        } else if (srcCompressionLevel === 0) {
                            if (desiredOutputCompressionLevel === 1) conversionFunc = thf;
                        }
                    }

                    outSphericalHarmonicsArray[shDestBase] = conversionFunc(shOut1[0]);
                    outSphericalHarmonicsArray[shDestBase + 1] = conversionFunc(shOut1[1]);
                    outSphericalHarmonicsArray[shDestBase + 2] = conversionFunc(shOut1[2]);

                    outSphericalHarmonicsArray[shDestBase + 3] = conversionFunc(shOut2[0]);
                    outSphericalHarmonicsArray[shDestBase + 4] = conversionFunc(shOut2[1]);
                    outSphericalHarmonicsArray[shDestBase + 5] = conversionFunc(shOut2[2]);

                    outSphericalHarmonicsArray[shDestBase + 6] = conversionFunc(shOut3[0]);
                    outSphericalHarmonicsArray[shDestBase + 7] = conversionFunc(shOut3[1]);
                    outSphericalHarmonicsArray[shDestBase + 8] = conversionFunc(shOut3[2]);

                    if (outSphericalHarmonicsDegree >= 2) {

                        srcCompressionLevel = this.compressionLevel;

                        set3(shIn1, sectionFloatArray[sphericalHarmonicsSrcBase + 9],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 14],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 19]);

                        set3(shIn2, sectionFloatArray[sphericalHarmonicsSrcBase + 10],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 15],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 20]);

                        set3(shIn3, sectionFloatArray[sphericalHarmonicsSrcBase + 11],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 16],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 21]);

                        set3(shIn4, sectionFloatArray[sphericalHarmonicsSrcBase + 12],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 17],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 22]);

                        set3(shIn5, sectionFloatArray[sphericalHarmonicsSrcBase + 13],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 18],
                                    sectionFloatArray[sphericalHarmonicsSrcBase + 23]);

                        if (transform) {
                            this.fbfA3(shIn1, shIn1);
                            this.fbfA3(shIn2, shIn2);
                            this.fbfA3(shIn3, shIn3);
                            this.fbfA3(shIn4, shIn4);
                            this.fbfA3(shIn5, shIn5);

                            srcCompressionLevel = 0;

                            sh21[0] = kSqrt0104 * ((sh13[2] * sh11[0] + sh13[0] * sh11[2]) + (sh11[2] * sh13[0] + sh11[0] * sh13[2]));
                            sh21[1] = (sh13[1] * sh11[0] + sh11[1] * sh13[0]);
                            sh21[2] = kSqrt0304 * (sh13[1] * sh11[1] + sh11[1] * sh13[1]);
                            sh21[3] = (sh13[1] * sh11[2] + sh11[1] * sh13[2]);
                            sh21[4] = kSqrt0104 * ((sh13[2] * sh11[2] - sh13[0] * sh11[0]) + (sh11[2] * sh13[2] - sh11[0] * sh13[0]));
                            dot5(shIn1, shIn2, shIn3, shIn4, shIn5, sh21, shOut1);

                            sh22[0] = kSqrt0104 * ((sh12[2] * sh11[0] + sh12[0] * sh11[2]) + (sh11[2] * sh12[0] + sh11[0] * sh12[2]));
                            sh22[1] = sh12[1] * sh11[0] + sh11[1] * sh12[0];
                            sh22[2] = kSqrt0304 * (sh12[1] * sh11[1] + sh11[1] * sh12[1]);
                            sh22[3] = sh12[1] * sh11[2] + sh11[1] * sh12[2];
                            sh22[4] = kSqrt0104 * ((sh12[2] * sh11[2] - sh12[0] * sh11[0]) + (sh11[2] * sh12[2] - sh11[0] * sh12[0]));
                            dot5(shIn1, shIn2, shIn3, shIn4, shIn5, sh22, shOut2);

                            sh23[0] = kSqrt0103 * (sh12[2] * sh12[0] + sh12[0] * sh12[2]) + -kSqrt0112 *
                                      ((sh13[2] * sh13[0] + sh13[0] * sh13[2]) + (sh11[2] * sh11[0] + sh11[0] * sh11[2]));
                            sh23[1] = kSqrt0403 * sh12[1] * sh12[0] + -kSqrt0103 * (sh13[1] * sh13[0] + sh11[1] * sh11[0]);
                            sh23[2] = sh12[1] * sh12[1] + -kSqrt0104 * (sh13[1] * sh13[1] + sh11[1] * sh11[1]);
                            sh23[3] = kSqrt0403 * sh12[1] * sh12[2] + -kSqrt0103 * (sh13[1] * sh13[2] + sh11[1] * sh11[2]);
                            sh23[4] = kSqrt0103 * (sh12[2] * sh12[2] - sh12[0] * sh12[0]) + -kSqrt0112 *
                                      ((sh13[2] * sh13[2] - sh13[0] * sh13[0]) + (sh11[2] * sh11[2] - sh11[0] * sh11[0]));
                            dot5(shIn1, shIn2, shIn3, shIn4, shIn5, sh23, shOut3);

                            sh24[0] = kSqrt0104 * ((sh12[2] * sh13[0] + sh12[0] * sh13[2]) + (sh13[2] * sh12[0] + sh13[0] * sh12[2]));
                            sh24[1] = sh12[1] * sh13[0] + sh13[1] * sh12[0];
                            sh24[2] = kSqrt0304 * (sh12[1] * sh13[1] + sh13[1] * sh12[1]);
                            sh24[3] = sh12[1] * sh13[2] + sh13[1] * sh12[2];
                            sh24[4] = kSqrt0104 * ((sh12[2] * sh13[2] - sh12[0] * sh13[0]) + (sh13[2] * sh12[2] - sh13[0] * sh12[0]));
                            dot5(shIn1, shIn2, shIn3, shIn4, shIn5, sh24, shOut4);

                            sh25[0] = kSqrt0104 * ((sh13[2] * sh13[0] + sh13[0] * sh13[2]) - (sh11[2] * sh11[0] + sh11[0] * sh11[2]));
                            sh25[1] = (sh13[1] * sh13[0] - sh11[1] * sh11[0]);
                            sh25[2] = kSqrt0304 * (sh13[1] * sh13[1] - sh11[1] * sh11[1]);
                            sh25[3] = (sh13[1] * sh13[2] - sh11[1] * sh11[2]);
                            sh25[4] = kSqrt0104 * ((sh13[2] * sh13[2] - sh13[0] * sh13[0]) - (sh11[2] * sh11[2] - sh11[0] * sh11[0]));
                            dot5(shIn1, shIn2, shIn3, shIn4, shIn5, sh25, shOut5);
                        } else {
                            copy3(shIn1, shOut1);
                            copy3(shIn2, shOut2);
                            copy3(shIn3, shOut3);
                            copy3(shIn4, shOut4);
                            copy3(shIn5, shOut5);
                        }

                        let conversionFunc = noop;
                        if (srcCompressionLevel !== desiredOutputCompressionLevel) {
                            if (srcCompressionLevel === 1) {
                                if (desiredOutputCompressionLevel === 0) conversionFunc = fbf;
                            } else if (srcCompressionLevel === 0) {
                                if (desiredOutputCompressionLevel === 1) conversionFunc = thf;
                            }
                        }

                        outSphericalHarmonicsArray[shDestBase + 9] = conversionFunc(shOut1[0]);
                        outSphericalHarmonicsArray[shDestBase + 10] = conversionFunc(shOut1[1]);
                        outSphericalHarmonicsArray[shDestBase + 11] = conversionFunc(shOut1[2]);

                        outSphericalHarmonicsArray[shDestBase + 12] = conversionFunc(shOut2[0]);
                        outSphericalHarmonicsArray[shDestBase + 13] = conversionFunc(shOut2[1]);
                        outSphericalHarmonicsArray[shDestBase + 14] = conversionFunc(shOut2[2]);

                        outSphericalHarmonicsArray[shDestBase + 15] = conversionFunc(shOut3[0]);
                        outSphericalHarmonicsArray[shDestBase + 16] = conversionFunc(shOut3[1]);
                        outSphericalHarmonicsArray[shDestBase + 17] = conversionFunc(shOut3[2]);

                        outSphericalHarmonicsArray[shDestBase + 18] = conversionFunc(shOut4[0]);
                        outSphericalHarmonicsArray[shDestBase + 19] = conversionFunc(shOut4[1]);
                        outSphericalHarmonicsArray[shDestBase + 20] = conversionFunc(shOut4[2]);

                        outSphericalHarmonicsArray[shDestBase + 21] = conversionFunc(shOut5[0]);
                        outSphericalHarmonicsArray[shDestBase + 22] = conversionFunc(shOut5[1]);
                        outSphericalHarmonicsArray[shDestBase + 23] = conversionFunc(shOut5[2]);

                    }
                }
            }
        };

    }();

    static parseHeader(buffer) {
        const headerArrayUint8 = new Uint8Array(buffer, 0, SplatBuffer.HeaderSizeBytes);
        const headerArrayUint16 = new Uint16Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 2);
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const headerArrayFloat32 = new Float32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const versionMajor = headerArrayUint8[0];
        const versionMinor = headerArrayUint8[1];
        const maxSectionCount = headerArrayUint32[1];
        const sectionCount = headerArrayUint32[2];
        const maxSplatCount = headerArrayUint32[3];
        const splatCount = headerArrayUint32[4];
        const compressionLevel = headerArrayUint16[10];
        const sceneCenter = new THREE.Vector3(headerArrayFloat32[6], headerArrayFloat32[7], headerArrayFloat32[8]);
        const sphericalHarmonicsDegree = headerArrayUint16[18];

        return {
            versionMajor,
            versionMinor,
            maxSectionCount,
            sectionCount,
            maxSplatCount,
            splatCount,
            compressionLevel,
            sceneCenter,
            sphericalHarmonicsDegree
        };
    }

    static writeHeaderCountsToBuffer(sectionCount, splatCount, buffer) {
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        headerArrayUint32[2] = sectionCount;
        headerArrayUint32[4] = splatCount;
    }

    static writeHeaderToBuffer(header, buffer) {
        const headerArrayUint8 = new Uint8Array(buffer, 0, SplatBuffer.HeaderSizeBytes);
        const headerArrayUint16 = new Uint16Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 2);
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const headerArrayFloat32 = new Float32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        headerArrayUint8[0] = header.versionMajor;
        headerArrayUint8[1] = header.versionMinor;
        headerArrayUint8[2] = 0; // unused for now
        headerArrayUint8[3] = 0; // unused for now
        headerArrayUint32[1] = header.maxSectionCount;
        headerArrayUint32[2] = header.sectionCount;
        headerArrayUint32[3] = header.maxSplatCount;
        headerArrayUint32[4] = header.splatCount;
        headerArrayUint16[10] = header.compressionLevel;
        headerArrayFloat32[6] = header.sceneCenter.x;
        headerArrayFloat32[7] = header.sceneCenter.y;
        headerArrayFloat32[8] = header.sceneCenter.z;
        headerArrayUint16[18] = header.sphericalHarmonicsDegree;
    }

    static parseSectionHeaders(header, buffer, offset = 0, secLoadedCountsToMax) {
        const compressionLevel = header.compressionLevel;
        const { bytesPerSplat } = SplatBuffer.calculateComponentStorage(compressionLevel, header.sphericalHarmonicsDegree);

        const maxSectionCount = header.maxSectionCount;
        const sectionHeaderArrayUint16 = new Uint16Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 2);
        const sectionHeaderArrayUint32 = new Uint32Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 4);
        const sectionHeaderArrayFloat32 = new Float32Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 4);

        const sectionHeaders = [];
        let sectionHeaderBase = 0;
        let sectionHeaderBaseUint16 = sectionHeaderBase / 2;
        let sectionHeaderBaseUint32 = sectionHeaderBase / 4;
        let sectionBase = SplatBuffer.HeaderSizeBytes + header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes;
        let splatCountOffset = 0;
        for (let i = 0; i < maxSectionCount; i++) {
            const maxSplatCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 1];
            const bucketSize = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 2];
            const bucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 3];
            const bucketBlockSize = sectionHeaderArrayFloat32[sectionHeaderBaseUint32 + 4];
            const halfBucketBlockSize = bucketBlockSize / 2.0;
            const bucketStorageSizeBytes = sectionHeaderArrayUint16[sectionHeaderBaseUint16 + 10];
            const compressionScaleRange = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 6] ||
                                          SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;
            const fullBucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 8];
            const partiallyFilledBucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 9];
            const bucketsMetaDataSizeBytes = partiallyFilledBucketCount * 4;
            const bucketsStorageSizeBytes = bucketStorageSizeBytes * bucketCount + bucketsMetaDataSizeBytes;

            const splatDataStorageSizeBytes = bytesPerSplat * maxSplatCount;
            const storageSizeBytes = splatDataStorageSizeBytes + bucketsStorageSizeBytes;
            const sectionHeader = {
                splatCountOffset: splatCountOffset,
                splatCount: secLoadedCountsToMax ? maxSplatCount : 0,
                maxSplatCount: maxSplatCount,
                bucketSize: bucketSize,
                bucketCount: bucketCount,
                bucketBlockSize: bucketBlockSize,
                halfBucketBlockSize: halfBucketBlockSize,
                bucketStorageSizeBytes: bucketStorageSizeBytes,
                bucketsStorageSizeBytes: bucketsStorageSizeBytes,
                splatDataStorageSizeBytes: splatDataStorageSizeBytes,
                storageSizeBytes: storageSizeBytes,
                compressionScaleRange: compressionScaleRange,
                compressionScaleFactor: halfBucketBlockSize / compressionScaleRange,
                base: sectionBase,
                bucketsBase: sectionBase + bucketsMetaDataSizeBytes,
                dataBase: sectionBase + bucketsStorageSizeBytes,
                fullBucketCount: fullBucketCount,
                partiallyFilledBucketCount: partiallyFilledBucketCount
            };
            sectionHeaders[i] = sectionHeader;
            sectionBase += storageSizeBytes;
            sectionHeaderBase += SplatBuffer.SectionHeaderSizeBytes;
            sectionHeaderBaseUint16 = sectionHeaderBase / 2;
            sectionHeaderBaseUint32 = sectionHeaderBase / 4;
            splatCountOffset += maxSplatCount;
        }

        return sectionHeaders;
    }


    static writeSectionHeaderToBuffer(sectionHeader, compressionLevel, buffer, offset = 0) {
        const sectionHeadeArrayUint16 = new Uint16Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 2);
        const sectionHeadeArrayUint32 = new Uint32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);
        const sectionHeadeArrayFloat32 = new Float32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);

        sectionHeadeArrayUint32[0] = sectionHeader.splatCount;
        sectionHeadeArrayUint32[1] = sectionHeader.maxSplatCount;
        sectionHeadeArrayUint32[2] = compressionLevel === 1 ? sectionHeader.bucketSize : 0;
        sectionHeadeArrayUint32[3] = compressionLevel === 1 ? sectionHeader.bucketCount : 0;
        sectionHeadeArrayFloat32[4] = compressionLevel === 1 ? sectionHeader.bucketBlockSize : 0.0;
        sectionHeadeArrayUint16[10] = compressionLevel === 1 ? SplatBuffer.BucketStorageSizeBytes : 0;
        sectionHeadeArrayUint32[6] = compressionLevel === 1 ? sectionHeader.compressionScaleRange : 0;
        sectionHeadeArrayUint32[7] = sectionHeader.storageSizeBytes;
        sectionHeadeArrayUint32[8] = compressionLevel === 1 ? sectionHeader.fullBucketCount : 0;
        sectionHeadeArrayUint32[9] = compressionLevel === 1 ? sectionHeader.partiallyFilledBucketCount : 0;
    }

    static writeSectionHeaderSplatCountToBuffer(splatCount, buffer, offset = 0) {
        const sectionHeadeArrayUint32 = new Uint32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);
        sectionHeadeArrayUint32[0] = splatCount;
    }

    constructFromBuffer(bufferData, secLoadedCountsToMax) {
        this.bufferData = bufferData;

        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSectionMap = [];

        const header = SplatBuffer.parseHeader(this.bufferData);
        this.versionMajor = header.versionMajor;
        this.versionMinor = header.versionMinor;
        this.maxSectionCount = header.maxSectionCount;
        this.sectionCount = secLoadedCountsToMax ? header.maxSectionCount : 0;
        this.maxSplatCount = header.maxSplatCount;
        this.splatCount = secLoadedCountsToMax ? header.maxSplatCount : 0;
        this.compressionLevel = header.compressionLevel;
        this.sceneCenter = new THREE.Vector3().copy(header.sceneCenter);
        this.sphericalHarmonicsDegree = header.sphericalHarmonicsDegree;

        const {bytesPerCenter, bytesPerScale, bytesPerRotation, bytesPerColor,
               sphericalHarmonicsComponentsPerSplat, sphericalHarmonicsBytesPerSplat,
               bytesPerSplat} = SplatBuffer.calculateComponentStorage(this.compressionLevel, this.sphericalHarmonicsDegree);

        this.bytesPerCenter = bytesPerCenter;
        this.bytesPerScale = bytesPerScale;
        this.bytesPerRotation = bytesPerRotation;
        this.bytesPerColor = bytesPerColor;
        this.sphericalHarmonicsComponentsPerSplat = sphericalHarmonicsComponentsPerSplat;
        this.sphericalHarmonicsBytesPerSplat = sphericalHarmonicsBytesPerSplat;
        this.bytesPerSplat = bytesPerSplat;

        this.float32PerSplat = this.bytesPerSplat / 4;
        this.uint32PerSplat = this.bytesPerSplat / 4;
        this.uint16PerSplat = this.bytesPerSplat / 2;

        this.sections = SplatBuffer.parseSectionHeaders(header, this.bufferData, SplatBuffer.HeaderSizeBytes, secLoadedCountsToMax);

        this.linkBufferArrays();
        this.buildMaps();
    }

    static calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree) {
        const bytesPerCenter = SplatBuffer.CompressionLevels[compressionLevel].BytesPerCenter;
        const bytesPerScale = SplatBuffer.CompressionLevels[compressionLevel].BytesPerScale;
        const bytesPerRotation = SplatBuffer.CompressionLevels[compressionLevel].BytesPerRotation;
        const bytesPerColor = SplatBuffer.CompressionLevels[compressionLevel].BytesPerColor;
        const sphericalHarmonicsComponentsPerSplat = getSphericalHarmonicsComponentCountForDegree(sphericalHarmonicsDegree);
        const sphericalHarmonicsBytesPerSplat = SplatBuffer.CompressionLevels[compressionLevel].BytesPerSphericalHarmonicsComponent *
                                                sphericalHarmonicsComponentsPerSplat;
        const bytesPerSplat = bytesPerCenter + bytesPerScale + bytesPerRotation +
                              bytesPerColor + sphericalHarmonicsBytesPerSplat;
        return {
            bytesPerCenter,
            bytesPerScale,
            bytesPerRotation,
            bytesPerColor,
            sphericalHarmonicsComponentsPerSplat,
            sphericalHarmonicsBytesPerSplat,
            bytesPerSplat
        };
    }

    linkBufferArrays() {
        for (let i = 0; i < this.maxSectionCount; i++) {
            const section = this.sections[i];
            section.dataArrayUint8 = new Uint8Array(this.bufferData, section.dataBase, section.maxSplatCount * this.bytesPerSplat);
            section.dataArrayUint16 = new Uint16Array(this.bufferData, section.dataBase, section.maxSplatCount * this.uint16PerSplat);
            section.dataArrayUint32 = new Uint32Array(this.bufferData, section.dataBase, section.maxSplatCount * this.uint32PerSplat);
            section.dataArrayFloat32 = new Float32Array(this.bufferData, section.dataBase, section.maxSplatCount * this.float32PerSplat);
            section.bucketArray = new Float32Array(this.bufferData, section.bucketsBase,
                                                   section.bucketCount * SplatBuffer.BucketStorageSizeFloats);
            if (section.partiallyFilledBucketCount > 0) {
                section.partiallyFilledBucketLengths = new Uint32Array(this.bufferData, section.base,
                                                                       section.partiallyFilledBucketCount);
            }
        }
    }

    buildMaps() {
        let cumulativeSplatCount = 0;
        for (let i = 0; i < this.maxSectionCount; i++) {
            const section = this.sections[i];
            for (let j = 0; j < section.maxSplatCount; j++) {
                const globalSplatIndex = cumulativeSplatCount + j;
                this.globalSplatIndexToLocalSplatIndexMap[globalSplatIndex] = j;
                this.globalSplatIndexToSectionMap[globalSplatIndex] = i;
            }
            cumulativeSplatCount += section.maxSplatCount;
        }
    }

    updateLoadedCounts(newSectionCount, newSplatCount) {
        SplatBuffer.writeHeaderCountsToBuffer(newSectionCount, newSplatCount, this.bufferData);
        this.sectionCount = newSectionCount;
        this.splatCount = newSplatCount;
    }

    updateSectionLoadedCounts(sectionIndex, newSplatCount) {
        const sectionHeaderOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * sectionIndex;
        SplatBuffer.writeSectionHeaderSplatCountToBuffer(newSplatCount, this.bufferData, sectionHeaderOffset);
        this.sections[sectionIndex].splatCount = newSplatCount;
    }

    static generateFromUncompressedSplatArrays(splatArrays, minimumAlpha, compressionLevel,
                                               sceneCenter, blockSize, bucketSize, options = []) {

        let sphericalHarmonicsDegree = 0;

        for (let sa = 0; sa < splatArrays.length; sa ++) {
            const splatArray = splatArrays[sa];
            if (sa === 0 || splatArray.sphericalHarmonicsDegree < sphericalHarmonicsDegree) {
                if (sa > 0 && splatArray.sphericalHarmonicsDegree !== sphericalHarmonicsDegree) {
                    const msg = 'SplatBuffer::generateFromUncompressedSplatArrays() -> ' +
                                'all splat arrays must have the same spherical harmonics degree.';
                    throw new Error(msg);
                }
                sphericalHarmonicsDegree = splatArray.sphericalHarmonicsDegree;
            }
        }

        const {bytesPerCenter, bytesPerScale, bytesPerRotation, bytesPerColor, sphericalHarmonicsComponentsPerSplat,
              bytesPerSplat} = SplatBuffer.calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree);

        const compressionScaleRange = SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;

        const sectionBuffers = [];
        const sectionHeaderBuffers = [];
        let totalSplatCount = 0;

        const tempRotation = new THREE.Quaternion();
        const thf = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);

        for (let sa = 0; sa < splatArrays.length; sa ++) {
            const splatArray = splatArrays[sa];

            const sectionOptions = options[sa] || {};

            const sectionBlockSize = (sectionOptions.blockSizeFactor || 1) * (blockSize || SplatBuffer.BucketBlockSize);
            const sectionBucketSize = Math.ceil((sectionOptions.bucketSizeFactor || 1) * (bucketSize || SplatBuffer.BucketSize));

            const validSplats = new UncompressedSplatArray(sphericalHarmonicsDegree);

            for (let i = 0; i < splatArray.splatCount; i++) {
                const targetSplat = splatArray.splats[i];
                let alpha;
                if (targetSplat[UncompressedSplatArray.OFFSET.OPACITY]) {
                    alpha = targetSplat[UncompressedSplatArray.OFFSET.OPACITY];
                } else {
                    alpha = 255;
                }
                if (alpha >= minimumAlpha) {
                    validSplats.addSplat(targetSplat);
                }
            }

            const bucketInfo = SplatBuffer.computeBucketsForUncompressedSplatArray(validSplats, sectionBlockSize, sectionBucketSize);
            const fullBucketCount = bucketInfo.fullBuckets.length;
            const partiallyFullBucketLengths = bucketInfo.partiallyFullBuckets.map((bucket) => bucket.splats.length);
            const partiallyFilledBucketCount = partiallyFullBucketLengths.length;
            const buckets = [...bucketInfo.fullBuckets, ...bucketInfo.partiallyFullBuckets];

            const sectionDataSizeBytes = validSplats.splats.length * bytesPerSplat;
            const bucketMetaDataSizeBytes = partiallyFilledBucketCount * 4;
            const bucketDataBytes = compressionLevel === 1 ? buckets.length *
                                                             SplatBuffer.BucketStorageSizeBytes + bucketMetaDataSizeBytes : 0;
            const sectionSizeBytes = sectionDataSizeBytes + bucketDataBytes;
            const sectionBuffer = new ArrayBuffer(sectionSizeBytes);

            const blockHalfSize = sectionBlockSize / 2.0;
            const compressionScaleFactor = compressionScaleRange / blockHalfSize;
            const doubleCompressionScaleRange = compressionScaleRange * 2 + 1;

            const bucketCenter = new THREE.Vector3();
            const bucketCenterDelta = new THREE.Vector3();
            let outSplatCount = 0;
            for (let b = 0; b < buckets.length; b++) {
                const bucket = buckets[b];
                bucketCenter.fromArray(bucket.center);
                for (let i = 0; i < bucket.splats.length; i++) {
                    let row = bucket.splats[i];
                    const targetSplat = validSplats.splats[row];

                    const centerBase = bucketDataBytes + outSplatCount * bytesPerSplat;
                    const scaleBase = centerBase + bytesPerCenter;
                    const rotationBase = scaleBase + bytesPerScale;
                    const colorBase = rotationBase + bytesPerRotation;
                    const sphericalHarmonicsBase = colorBase + bytesPerColor;
                    if (compressionLevel === 0) {
                        const center = new Float32Array(sectionBuffer, centerBase, SplatBuffer.CenterComponentCount);
                        const rot = new Float32Array(sectionBuffer, rotationBase, SplatBuffer.RotationComponentCount);
                        const scale = new Float32Array(sectionBuffer, scaleBase, SplatBuffer.ScaleComponentCount);
                        if (targetSplat[UncompressedSplatArray.OFFSET.SCALE0] !== undefined) {
                            tempRotation.set(targetSplat[UncompressedSplatArray.OFFSET.ROTATION0],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION1],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION2],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION3]);
                            tempRotation.normalize();
                            rot.set([tempRotation.x, tempRotation.y, tempRotation.z, tempRotation.w]);
                            scale.set([targetSplat[UncompressedSplatArray.OFFSET.SCALE0],
                                       targetSplat[UncompressedSplatArray.OFFSET.SCALE1],
                                       targetSplat[UncompressedSplatArray.OFFSET.SCALE2]]);
                        } else {
                            rot.set([1.0, 0.0, 0.0, 0.0]);
                            scale.set([0.01, 0.01, 0.01]);
                        }
                        center.set([targetSplat[UncompressedSplatArray.OFFSET.X],
                                    targetSplat[UncompressedSplatArray.OFFSET.Y],
                                    targetSplat[UncompressedSplatArray.OFFSET.Z]]);
                        if (sphericalHarmonicsDegree > 0) {
                           const sphericalHarmonics = new Float32Array(sectionBuffer, sphericalHarmonicsBase,
                                                                       sphericalHarmonicsComponentsPerSplat);
                           if (sphericalHarmonicsDegree >= 1) {
                                sphericalHarmonics[0] = targetSplat[UncompressedSplatArray.OFFSET.FRC0];
                                sphericalHarmonics[1] = targetSplat[UncompressedSplatArray.OFFSET.FRC1];
                                sphericalHarmonics[2] = targetSplat[UncompressedSplatArray.OFFSET.FRC2];
                                sphericalHarmonics[3] = targetSplat[UncompressedSplatArray.OFFSET.FRC3];
                                sphericalHarmonics[4] = targetSplat[UncompressedSplatArray.OFFSET.FRC4];
                                sphericalHarmonics[5] = targetSplat[UncompressedSplatArray.OFFSET.FRC5];
                                sphericalHarmonics[6] = targetSplat[UncompressedSplatArray.OFFSET.FRC6];
                                sphericalHarmonics[7] = targetSplat[UncompressedSplatArray.OFFSET.FRC7];
                                sphericalHarmonics[8] = targetSplat[UncompressedSplatArray.OFFSET.FRC8];

                                if (sphericalHarmonicsDegree >= 2) {
                                    sphericalHarmonics[9] = targetSplat[UncompressedSplatArray.OFFSET.FRC9];
                                    sphericalHarmonics[10] = targetSplat[UncompressedSplatArray.OFFSET.FRC10];
                                    sphericalHarmonics[11] = targetSplat[UncompressedSplatArray.OFFSET.FRC11];
                                    sphericalHarmonics[12] = targetSplat[UncompressedSplatArray.OFFSET.FRC12];
                                    sphericalHarmonics[13] = targetSplat[UncompressedSplatArray.OFFSET.FRC13];
                                    sphericalHarmonics[14] = targetSplat[UncompressedSplatArray.OFFSET.FRC14];
                                    sphericalHarmonics[15] = targetSplat[UncompressedSplatArray.OFFSET.FRC15];
                                    sphericalHarmonics[16] = targetSplat[UncompressedSplatArray.OFFSET.FRC16];
                                    sphericalHarmonics[17] = targetSplat[UncompressedSplatArray.OFFSET.FRC17];
                                    sphericalHarmonics[18] = targetSplat[UncompressedSplatArray.OFFSET.FRC18];
                                    sphericalHarmonics[19] = targetSplat[UncompressedSplatArray.OFFSET.FRC19];
                                    sphericalHarmonics[20] = targetSplat[UncompressedSplatArray.OFFSET.FRC20];
                                    sphericalHarmonics[21] = targetSplat[UncompressedSplatArray.OFFSET.FRC21];
                                    sphericalHarmonics[22] = targetSplat[UncompressedSplatArray.OFFSET.FRC22];
                                    sphericalHarmonics[23] = targetSplat[UncompressedSplatArray.OFFSET.FRC23];
                                }
                           }
                        }
                    } else {
                        const center = new Uint16Array(sectionBuffer, centerBase, SplatBuffer.CenterComponentCount);
                        const rot = new Uint16Array(sectionBuffer, rotationBase, SplatBuffer.RotationComponentCount);
                        const scale = new Uint16Array(sectionBuffer, scaleBase, SplatBuffer.ScaleComponentCount);

                        if (targetSplat[UncompressedSplatArray.OFFSET.SCALE0] !== undefined) {
                            tempRotation.set(targetSplat[UncompressedSplatArray.OFFSET.ROTATION0],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION1],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION2],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION3]);
                            tempRotation.normalize();
                            rot.set([thf(tempRotation.x), thf(tempRotation.y), thf(tempRotation.z), thf(tempRotation.w)]);
                            scale.set([thf(targetSplat[UncompressedSplatArray.OFFSET.SCALE0]),
                                       thf(targetSplat[UncompressedSplatArray.OFFSET.SCALE1]),
                                       thf(targetSplat[UncompressedSplatArray.OFFSET.SCALE2])]);
                        } else {
                            rot.set([thf(1.), 0, 0, 0]);
                            scale.set([thf(0.01), thf(0.01), thf(0.01)]);
                        }
                        bucketCenterDelta.set(targetSplat[UncompressedSplatArray.OFFSET.X],
                                              targetSplat[UncompressedSplatArray.OFFSET.Y],
                                              targetSplat[UncompressedSplatArray.OFFSET.Z]).sub(bucketCenter);
                        bucketCenterDelta.x = Math.round(bucketCenterDelta.x * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.x = clamp(bucketCenterDelta.x, 0, doubleCompressionScaleRange);
                        bucketCenterDelta.y = Math.round(bucketCenterDelta.y * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.y = clamp(bucketCenterDelta.y, 0, doubleCompressionScaleRange);
                        bucketCenterDelta.z = Math.round(bucketCenterDelta.z * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.z = clamp(bucketCenterDelta.z, 0, doubleCompressionScaleRange);
                        center.set([bucketCenterDelta.x, bucketCenterDelta.y, bucketCenterDelta.z]);
                        if (sphericalHarmonicsDegree > 0) {
                            const sphericalHarmonics = new Uint16Array(sectionBuffer, sphericalHarmonicsBase,
                                                                       sphericalHarmonicsComponentsPerSplat);
                            if (sphericalHarmonicsDegree >= 1) {
                                 sphericalHarmonics[0] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC0]);
                                 sphericalHarmonics[1] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC1]);
                                 sphericalHarmonics[2] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC2]);
                                 sphericalHarmonics[3] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC3]);
                                 sphericalHarmonics[4] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC4]);
                                 sphericalHarmonics[5] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC5]);
                                 sphericalHarmonics[6] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC6]);
                                 sphericalHarmonics[7] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC7]);
                                 sphericalHarmonics[8] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC8]);

                                 if (sphericalHarmonicsDegree >= 2) {
                                    sphericalHarmonics[9] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC9]);
                                    sphericalHarmonics[10] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC10]);
                                    sphericalHarmonics[11] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC11]);
                                    sphericalHarmonics[12] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC12]);
                                    sphericalHarmonics[13] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC13]);
                                    sphericalHarmonics[14] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC14]);
                                    sphericalHarmonics[15] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC15]);
                                    sphericalHarmonics[16] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC16]);
                                    sphericalHarmonics[17] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC17]);
                                    sphericalHarmonics[18] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC18]);
                                    sphericalHarmonics[19] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC19]);
                                    sphericalHarmonics[20] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC20]);
                                    sphericalHarmonics[21] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC21]);
                                    sphericalHarmonics[22] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC22]);
                                    sphericalHarmonics[23] = thf(targetSplat[UncompressedSplatArray.OFFSET.FRC23]);
                                }
                            }
                         }
                    }

                    const rgba = new Uint8ClampedArray(sectionBuffer, colorBase, 4);

                    if (targetSplat[UncompressedSplatArray.OFFSET.FDC0] !== undefined) {
                        rgba.set([targetSplat[UncompressedSplatArray.OFFSET.FDC0],
                                  targetSplat[UncompressedSplatArray.OFFSET.FDC1],
                                  targetSplat[UncompressedSplatArray.OFFSET.FDC2]]);
                    } else {
                        rgba.set([255, 0, 0]);
                    }
                    if (targetSplat[UncompressedSplatArray.OFFSET.OPACITY] !== undefined) {
                        rgba[3] = targetSplat[UncompressedSplatArray.OFFSET.OPACITY];
                    } else {
                        rgba[3] = 255;
                    }

                    outSplatCount++;
                }
            }
            totalSplatCount += outSplatCount;

            if (compressionLevel === 1) {
                const bucketMetaDataArray = new Uint32Array(sectionBuffer, 0, partiallyFullBucketLengths.length * 4);
                for (let pfb = 0; pfb < partiallyFullBucketLengths.length; pfb ++) {
                    bucketMetaDataArray[pfb] = partiallyFullBucketLengths[pfb];
                }
                const bucketArray = new Float32Array(sectionBuffer, bucketMetaDataSizeBytes,
                                                     buckets.length * SplatBuffer.BucketStorageSizeFloats);
                for (let b = 0; b < buckets.length; b++) {
                    const bucket = buckets[b];
                    const base = b * 3;
                    bucketArray[base] = bucket.center[0];
                    bucketArray[base + 1] = bucket.center[1];
                    bucketArray[base + 2] = bucket.center[2];
                }
            }
            sectionBuffers.push(sectionBuffer);

            const sectionHeaderBuffer = new ArrayBuffer(SplatBuffer.SectionHeaderSizeBytes);
            SplatBuffer.writeSectionHeaderToBuffer({
                maxSplatCount: outSplatCount,
                splatCount: outSplatCount,
                bucketSize: sectionBucketSize,
                bucketCount: buckets.length,
                bucketBlockSize: sectionBlockSize,
                compressionScaleRange: compressionScaleRange,
                storageSizeBytes: sectionSizeBytes,
                fullBucketCount: fullBucketCount,
                partiallyFilledBucketCount: partiallyFilledBucketCount
            }, compressionLevel, sectionHeaderBuffer, 0);
            sectionHeaderBuffers.push(sectionHeaderBuffer);

        }

        let sectionsCumulativeSizeBytes = 0;
        for (let sectionBuffer of sectionBuffers) sectionsCumulativeSizeBytes += sectionBuffer.byteLength;
        const unifiedBufferSize = SplatBuffer.HeaderSizeBytes +
                                  SplatBuffer.SectionHeaderSizeBytes * sectionBuffers.length + sectionsCumulativeSizeBytes;
        const unifiedBuffer = new ArrayBuffer(unifiedBufferSize);

        SplatBuffer.writeHeaderToBuffer({
            versionMajor: 0,
            versionMinor: 1,
            maxSectionCount: sectionBuffers.length,
            sectionCount: sectionBuffers.length,
            maxSplatCount: totalSplatCount,
            splatCount: totalSplatCount,
            compressionLevel: compressionLevel,
            sceneCenter: sceneCenter,
            sphericalHarmonicsDegree: sphericalHarmonicsDegree
        }, unifiedBuffer);

        let currentUnifiedBase = SplatBuffer.HeaderSizeBytes;
        for (let sectionHeaderBuffer of sectionHeaderBuffers) {
            new Uint8Array(unifiedBuffer, currentUnifiedBase, SplatBuffer.SectionHeaderSizeBytes).set(new Uint8Array(sectionHeaderBuffer));
            currentUnifiedBase += SplatBuffer.SectionHeaderSizeBytes;
        }

        for (let sectionBuffer of sectionBuffers) {
            new Uint8Array(unifiedBuffer, currentUnifiedBase, sectionBuffer.byteLength).set(new Uint8Array(sectionBuffer));
            currentUnifiedBase += sectionBuffer.byteLength;
        }

        const splatBuffer = new SplatBuffer(unifiedBuffer);
        return splatBuffer;
    }

    static computeBucketsForUncompressedSplatArray(splatArray, blockSize, bucketSize) {
        let splatCount = splatArray.splatCount;
        const halfBlockSize = blockSize / 2.0;

        const min = new THREE.Vector3();
        const max = new THREE.Vector3();

        for (let i = 0; i < splatCount; i++) {
            const targetSplat = splatArray.splats[i];
            const center = [targetSplat[UncompressedSplatArray.OFFSET.X],
                            targetSplat[UncompressedSplatArray.OFFSET.Y],
                            targetSplat[UncompressedSplatArray.OFFSET.Z]];
            if (i === 0 || center[0] < min.x) min.x = center[0];
            if (i === 0 || center[0] > max.x) max.x = center[0];
            if (i === 0 || center[1] < min.y) min.y = center[1];
            if (i === 0 || center[1] > max.y) max.y = center[1];
            if (i === 0 || center[2] < min.z) min.z = center[2];
            if (i === 0 || center[2] > max.z) max.z = center[2];
        }

        const dimensions = new THREE.Vector3().copy(max).sub(min);
        const yBlocks = Math.ceil(dimensions.y / blockSize);
        const zBlocks = Math.ceil(dimensions.z / blockSize);

        const blockCenter = new THREE.Vector3();
        const fullBuckets = [];
        const partiallyFullBuckets = {};

        for (let i = 0; i < splatCount; i++) {
            const targetSplat = splatArray.splats[i];
            const center = [targetSplat[UncompressedSplatArray.OFFSET.X],
                            targetSplat[UncompressedSplatArray.OFFSET.Y],
                            targetSplat[UncompressedSplatArray.OFFSET.Z]];
            const xBlock = Math.floor((center[0] - min.x) / blockSize);
            const yBlock = Math.floor((center[1] - min.y) / blockSize);
            const zBlock = Math.floor((center[2] - min.z) / blockSize);

            blockCenter.x = xBlock * blockSize + min.x + halfBlockSize;
            blockCenter.y = yBlock * blockSize + min.y + halfBlockSize;
            blockCenter.z = zBlock * blockSize + min.z + halfBlockSize;

            const bucketId = xBlock * (yBlocks * zBlocks) + yBlock * zBlocks + zBlock;
            let bucket = partiallyFullBuckets[bucketId];
            if (!bucket) {
                partiallyFullBuckets[bucketId] = bucket = {
                    'splats': [],
                    'center': blockCenter.toArray()
                };
            }

            bucket.splats.push(i);
            if (bucket.splats.length >= bucketSize) {
                fullBuckets.push(bucket);
                partiallyFullBuckets[bucketId] = null;
            }
        }

        const partiallyFullBucketArray = [];
        for (let bucketId in partiallyFullBuckets) {
            if (partiallyFullBuckets.hasOwnProperty(bucketId)) {
                const bucket = partiallyFullBuckets[bucketId];
                if (bucket) {
                    partiallyFullBucketArray.push(bucket);
                }
            }
        }

        return {
            'fullBuckets': fullBuckets,
            'partiallyFullBuckets': partiallyFullBucketArray,
        };
    }

}
