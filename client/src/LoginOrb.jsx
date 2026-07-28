import React, { useEffect, useRef } from 'react';

const supportsWebGL = () => {
    try {
        const canvas = document.createElement('canvas');
        return Boolean(
            window.WebGLRenderingContext
            && (canvas.getContext('webgl2')
                || canvas.getContext('webgl')
                || canvas.getContext('experimental-webgl'))
        );
    } catch (_) {
        return false;
    }
};

export default function LoginOrb() {
    const containerRef = useRef(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !supportsWebGL()) {
            container?.classList.add('is-fallback');
            return undefined;
        }

        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        let renderer = null;
        let scene = null;
        let camera = null;
        let resizeObserver = null;
        let animationFrame = 0;
        let disposed = false;
        let pointerX = 0;
        let pointerY = 0;
        let orbState = null;
        let THREE = null;

        const resize = () => {
            if (!renderer || !camera) return;
            const width = Math.max(1, container.clientWidth);
            const height = Math.max(1, container.clientHeight);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
        };

        const updatePointer = (event) => {
            pointerX = (event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
            pointerY = (event.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2;
        };

        const updateSatellites = (timeSeconds) => {
            if (!orbState) return;
            const { satelliteMesh, satelliteData, tempVector, dummy } = orbState;
            satelliteData.forEach((item, index) => {
                const angle = timeSeconds * item.speed + item.phase;
                tempVector.set(
                    Math.cos(angle) * item.radius * item.ellipse,
                    Math.sin(angle * 1.7 + item.phase) * item.yAmplitude,
                    Math.sin(angle) * item.radius
                );
                tempVector.applyEuler(item.tilt);
                dummy.position.copy(tempVector);
                dummy.rotation.set(angle * 0.35, angle, angle * 0.2);
                dummy.scale.setScalar(item.scale);
                dummy.updateMatrix();
                satelliteMesh.setMatrixAt(index, dummy.matrix);
            });
            satelliteMesh.instanceMatrix.needsUpdate = true;
        };

        const render = (timestamp, continueAnimation = true) => {
            if (disposed || !orbState || !renderer || !scene || !camera) return;
            const time = timestamp * 0.001;
            const { coreGroup } = orbState;

            coreGroup.rotation.y = time * 0.105 + pointerX * 0.14;
            coreGroup.rotation.x = Math.sin(time * 0.36) * 0.055 + pointerY * 0.08;
            coreGroup.rotation.z = Math.sin(time * 0.25) * 0.035;
            coreGroup.position.y = Math.sin(time * 0.72) * 0.23;

            orbState.wireMesh.rotation.y = -time * 0.055;
            orbState.wireMesh.rotation.x = time * 0.018;
            orbState.facetMesh.rotation.y = time * 0.042;
            orbState.facetMesh.rotation.z = -time * 0.025;

            orbState.rings.forEach((ring, index) => {
                const base = ring.userData.baseRotation;
                ring.rotation.x = base.x + time * (0.018 + index * 0.006);
                ring.rotation.y = base.y - time * (0.025 + index * 0.005);
                ring.rotation.z = base.z + Math.sin(time * 0.18 + index) * 0.08;
            });

            orbState.pulses.forEach((pulse, index) => {
                const wave = (time * 0.42 + index * 0.82) % 2.45;
                pulse.scale.setScalar(1 + wave * 0.28);
                pulse.material.opacity = Math.max(0.025, 0.25 - wave * 0.095);
            });

            updateSatellites(time);
            orbState.outerPoints.rotation.y = -time * 0.026;
            orbState.outerPoints.rotation.x = Math.sin(time * 0.16) * 0.08;
            orbState.coreMaterial.emissiveIntensity = 0.52 + Math.sin(time * 1.35) * 0.11;
            orbState.auraMaterial.opacity = 0.08 + Math.sin(time * 1.1) * 0.025;
            orbState.keyLight.intensity = 1.95 + Math.sin(time * 1.2) * 0.2;
            orbState.coreLight.intensity = 1.08 + Math.sin(time * 1.6) * 0.18;

            renderer.render(scene, camera);
            if (continueAnimation && !disposed) {
                animationFrame = window.requestAnimationFrame(nextTimestamp => render(nextTimestamp, true));
            }
        };

        const initialize = async () => {
            try {
                THREE = await import('three');
                if (disposed) return;
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
            camera.position.z = 31;

            renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                powerPreference: 'high-performance'
            });
            renderer.setClearColor(0x000000, 0);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.16;
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.domElement.className = 'login-orb-canvas';
            container.appendChild(renderer.domElement);

            const coreGroup = new THREE.Group();
            const ringGroup = new THREE.Group();
            const pulseGroup = new THREE.Group();
            coreGroup.add(ringGroup, pulseGroup);
            scene.add(coreGroup);

            const coreMaterial = new THREE.MeshPhongMaterial({
                color: 0x031137,
                emissive: 0x073bbf,
                emissiveIntensity: 0.56,
                specular: 0x64d9ff,
                shininess: 105,
                transparent: true,
                opacity: 0.82
            });
            coreGroup.add(new THREE.Mesh(new THREE.SphereGeometry(6.25, 56, 56), coreMaterial));

            const auraMaterial = new THREE.MeshBasicMaterial({
                color: 0x0b69ff,
                side: THREE.BackSide,
                transparent: true,
                opacity: 0.1,
                depthWrite: false
            });
            const auraMesh = new THREE.Mesh(new THREE.SphereGeometry(6.55, 36, 36), auraMaterial);
            auraMesh.scale.setScalar(1.08);
            coreGroup.add(auraMesh);

            const wireMesh = new THREE.Mesh(
                new THREE.SphereGeometry(6.46, 28, 22),
                new THREE.MeshBasicMaterial({
                    color: 0x2698ff,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.25,
                    depthWrite: false
                })
            );
            coreGroup.add(wireMesh);

            const facetMesh = new THREE.Mesh(
                new THREE.IcosahedronGeometry(6.68, 3),
                new THREE.MeshBasicMaterial({
                    color: 0x66d8ff,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.31,
                    depthWrite: false
                })
            );
            coreGroup.add(facetMesh);

            const rings = [0x169cff, 0x326cff, 0x58d8ff].map((color, index) => {
                const ring = new THREE.Mesh(
                    new THREE.TorusGeometry(8.15 + index * 1.18, 0.035, 8, 160),
                    new THREE.MeshBasicMaterial({
                        color,
                        transparent: true,
                        opacity: 0.34 - index * 0.045,
                        depthWrite: false
                    })
                );
                ring.rotation.set(
                    0.45 + index * 0.82,
                    0.24 + index * 0.66,
                    -0.2 + index * 0.71
                );
                ring.userData.baseRotation = ring.rotation.clone();
                ringGroup.add(ring);
                return ring;
            });

            const dummy = new THREE.Object3D();
            const origin = new THREE.Vector3();
            const nodeCount = window.innerWidth < 900 ? 120 : 220;
            const nodeMesh = new THREE.InstancedMesh(
                new THREE.BoxGeometry(0.16, 0.16, 0.16),
                new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 }),
                nodeCount
            );
            nodeMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
            for (let index = 0; index < nodeCount; index++) {
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(2 * Math.random() - 1);
                const radius = 6.5 + Math.random() * 0.38;
                dummy.position.setFromSphericalCoords(radius, phi, theta);
                dummy.lookAt(origin);
                const scale = 0.52 + Math.random() * 1.65;
                dummy.scale.set(scale, scale, 0.65 + Math.random() * 1.4);
                dummy.updateMatrix();
                nodeMesh.setMatrixAt(index, dummy.matrix);
                nodeMesh.setColorAt(
                    index,
                    new THREE.Color(index % 5 === 0 ? 0x73e8ff : (index % 2 ? 0x138cff : 0x315cff))
                );
            }
            nodeMesh.instanceMatrix.needsUpdate = true;
            if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
            coreGroup.add(nodeMesh);

            const satelliteCount = window.innerWidth < 900 ? 38 : 72;
            const satelliteMesh = new THREE.InstancedMesh(
                new THREE.SphereGeometry(0.105, 7, 7),
                new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.94 }),
                satelliteCount
            );
            satelliteMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            const satelliteData = [];
            for (let index = 0; index < satelliteCount; index++) {
                satelliteData.push({
                    radius: 7.5 + Math.random() * 5.1,
                    speed: 0.11 + Math.random() * 0.22,
                    phase: Math.random() * Math.PI * 2,
                    ellipse: 0.72 + Math.random() * 0.52,
                    yAmplitude: 0.4 + Math.random() * 1.25,
                    tilt: new THREE.Euler(
                        (Math.random() - 0.5) * 1.4,
                        (Math.random() - 0.5) * Math.PI,
                        (Math.random() - 0.5) * 1.45
                    ),
                    scale: 0.72 + Math.random() * 1.35
                });
                satelliteMesh.setColorAt(
                    index,
                    new THREE.Color(index % 3 === 0 ? 0x7eeaff : (index % 2 ? 0x218dff : 0x4258ff))
                );
            }
            if (satelliteMesh.instanceColor) satelliteMesh.instanceColor.needsUpdate = true;
            coreGroup.add(satelliteMesh);

            const pulses = [0, 1, 2].map(index => {
                const pulse = new THREE.Mesh(
                    new THREE.RingGeometry(6.95, 7.01, 96),
                    new THREE.MeshBasicMaterial({
                        color: index % 2 ? 0x3d7dff : 0x48d8ff,
                        side: THREE.DoubleSide,
                        transparent: true,
                        opacity: 0.25,
                        depthWrite: false
                    })
                );
                pulse.rotation.set(Math.PI / 2 + index * 0.48, index * 0.63, index * 0.37);
                pulseGroup.add(pulse);
                return pulse;
            });

            const outerCount = window.innerWidth < 900 ? 180 : 360;
            const outerPositions = new Float32Array(outerCount * 3);
            const outerColors = new Float32Array(outerCount * 3);
            for (let index = 0; index < outerCount; index++) {
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(2 * Math.random() - 1);
                const radius = 7.6 + Math.pow(Math.random(), 0.75) * 7.8;
                const sinPhi = Math.sin(phi);
                outerPositions[index * 3] = radius * sinPhi * Math.cos(theta);
                outerPositions[index * 3 + 1] = radius * Math.cos(phi);
                outerPositions[index * 3 + 2] = radius * sinPhi * Math.sin(theta);
                const color = new THREE.Color(index % 4 === 0 ? 0x72e5ff : (index % 2 ? 0x176cff : 0x2aa8ff));
                outerColors[index * 3] = color.r;
                outerColors[index * 3 + 1] = color.g;
                outerColors[index * 3 + 2] = color.b;
            }
            const outerGeometry = new THREE.BufferGeometry();
            outerGeometry.setAttribute('position', new THREE.BufferAttribute(outerPositions, 3));
            outerGeometry.setAttribute('color', new THREE.BufferAttribute(outerColors, 3));
            const outerPoints = new THREE.Points(
                outerGeometry,
                new THREE.PointsMaterial({
                    size: 0.13,
                    vertexColors: true,
                    transparent: true,
                    opacity: 0.74,
                    depthWrite: false
                })
            );
            scene.add(outerPoints);

            scene.add(new THREE.AmbientLight(0x17468f, 0.78));
            const keyLight = new THREE.PointLight(0x66dcff, 2.1, 70);
            keyLight.position.set(-5, 7, 13);
            scene.add(keyLight);
            const blueLight = new THREE.PointLight(0x174cff, 1.8, 65);
            blueLight.position.set(7, -5, 9);
            scene.add(blueLight);
            const coreLight = new THREE.PointLight(0x086fff, 1.2, 32);
            coreLight.position.set(0, 0, 3);
            scene.add(coreLight);

            orbState = {
                coreGroup,
                coreMaterial,
                auraMaterial,
                wireMesh,
                facetMesh,
                rings,
                pulses,
                satelliteMesh,
                satelliteData,
                dummy,
                tempVector: new THREE.Vector3(),
                outerPoints,
                keyLight,
                coreLight
            };

            resize();
            resizeObserver = window.ResizeObserver ? new ResizeObserver(resize) : null;
            resizeObserver?.observe(container);
            if (!resizeObserver) window.addEventListener('resize', resize);
            window.addEventListener('pointermove', updatePointer, { passive: true });
            updateSatellites(0);
            container.classList.add('is-ready');

            if (reducedMotion) render(0, false);
            else animationFrame = window.requestAnimationFrame(timestamp => render(timestamp, true));
            } catch (error) {
                console.warn('登录页智能核心动画初始化失败，已使用静态降级效果。', error);
                container.classList.add('is-fallback');
            }
        };
        initialize();

        return () => {
            disposed = true;
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            resizeObserver?.disconnect();
            window.removeEventListener('resize', resize);
            window.removeEventListener('pointermove', updatePointer);

            const geometries = new Set();
            const materials = new Set();
            scene?.traverse(object => {
                if (object.geometry) geometries.add(object.geometry);
                const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
                objectMaterials.filter(Boolean).forEach(material => materials.add(material));
            });
            geometries.forEach(geometry => geometry.dispose());
            materials.forEach(material => material.dispose());
            renderer?.dispose();
            renderer?.forceContextLoss?.();
            renderer?.domElement?.remove();
            container.classList.remove('is-ready');
        };
    }, []);

    return (
        <div ref={containerRef} className="login-orb-scene" aria-hidden="true">
            <div className="login-orb-fallback" />
        </div>
    );
}
