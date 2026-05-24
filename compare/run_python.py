"""Generate reference results from the original Python PTSNET.

Run inside the pinned virtualenv (see compare/README notes). Writes
compare/python_results.json, consumed by the JS parity test.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Point the (copied-from-wntr) toolkit at PTSNET's own bundled EPANET .so, and
# force the OWA-EPANET 2.2 build so the steady-state engine matches epanet-js
# (the default loader would pick the older libepanet2_amd64.so / EPANET 2.0).
import ptsnet.epanet.toolkit as tk
tk.epanet_toolkit = 'ptsnet.epanet.toolkit'
_orig_resource_filename = tk.resource_filename
def _resource_filename_22(pkg, rel):
    if rel.endswith('libepanet2_amd64.so'):
        rel = 'Linux/libepanet22_amd64.so'
    return _orig_resource_filename('ptsnet.epanet.toolkit', rel)
tk.resource_filename = _resource_filename_22
from ptsnet.simulation.sim import PTSNETSimulation

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLES = os.path.join(os.path.dirname(HERE), 'ptsnet', 'examples')

SIMPLE_INP = """[TITLE]
[JUNCTIONS]
 J1 0 50
 J2 0 0
[RESERVOIRS]
 R1 100
[PIPES]
 P1 R1 J1 1000 300 100 0 Open
 P2 J1 J2 1000 300 100 0 Open
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
"""

HAMMER_INP = """[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0
[RESERVOIRS]
 R1 100
 R2 90
[PIPES]
 P1 R1 J1 1000 500 100 0 Open
 P2 J2 R2 1000 500 100 0 Open
[VALVES]
 V1 J1 J2 500 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
"""


def write_inp(text, name):
    p = os.path.join('/tmp/cmp', name)
    os.makedirs('/tmp/cmp', exist_ok=True)
    open(p, 'w').write(text)
    return p


def dump(sim, node_labels=None, pipe_labels=None):
    """Serialize results. Optional label filters keep the committed fixture small
    (used for the large TNET3 network); rounding stays well below test tolerances."""
    out = {
        'time_step': float(sim.settings.time_step),
        'time_steps': int(sim.settings.time_steps),
        'num_points': int(sim.settings.num_points),
        'node_head': {}, 'pipe_start_flow': {}, 'pipe_end_flow': {},
    }
    nodes = sim['node']
    nl = set(node_labels) if node_labels is not None else None
    for label in nodes.labels:
        if nl is None or str(label) in nl:
            out['node_head'][str(label)] = [round(float(x), 6) for x in nodes.head[label]]
    ps = sim['pipe.start']
    pl = set(pipe_labels) if pipe_labels is not None else None
    for label in ps.labels:
        if pl is None or str(label) in pl:
            out['pipe_start_flow'][str(label)] = [round(float(x), 9) for x in ps.flowrate[label]]
    pe = sim['pipe.end']
    for label in pe.labels:
        if pl is None or str(label) in pl:
            out['pipe_end_flow'][str(label)] = [round(float(x), 9) for x in pe.flowrate[label]]
    return out


def run_simple():
    p = write_inp(SIMPLE_INP, 'simple.inp')
    sim = PTSNETSimulation(workspace_name='cmp_simple', inpfile=p, settings={
        'duration': 1.0, 'time_step': 0.05, 'default_wave_speed': 1000,
        'wave_speed_method': 'user', 'save_results': False})
    sim.run()
    return dump(sim)


def run_hammer():
    p = write_inp(HAMMER_INP, 'hammer.inp')
    sim = PTSNETSimulation(workspace_name='cmp_hammer', inpfile=p, settings={
        'duration': 4.0, 'time_step': 0.05, 'default_wave_speed': 1000,
        'wave_speed_method': 'user', 'save_results': False})
    sim.define_valve_operation('V1', initial_setting=1, final_setting=0, start_time=0.5, end_time=1.0)
    sim.run()
    return dump(sim)


# A representative subset (incl. the largest-diverging nodes and the operated
# valve's / pump's nodes) keeps the committed fixture small while staying a real check.
TNET3_NODES = [
    'JUNCTION-102', 'JUNCTION-103', '408-A', '408-B', '416-A', '416-B',
    'JUNCTION-73', 'JUNCTION-55', 'JUNCTION-56', 'JUNCTION-49', 'JUNCTION-23',
    'TANK-131', '217-A', '217-B', '221-A', '221-B',
]
TNET3_PIPES = ['LINK-98', 'LINK-59', 'LINK-15', 'LINK-139', 'LINK-99']


def tnet3_sim(name):
    p = os.path.join(EXAMPLES, 'TNET3.inp')
    return PTSNETSimulation(workspace_name=name, inpfile=p, settings={
        'duration': 4.0, 'time_step': 0.1, 'default_wave_speed': 1000,
        'wave_speed_method': 'optimal', 'save_results': False})


def run_tnet3():
    sim = tnet3_sim('cmp_tnet3')
    sim.define_valve_operation('VALVE-179', initial_setting=1, final_setting=0, start_time=1, end_time=2)
    sim.run()
    return dump(sim, TNET3_NODES, TNET3_PIPES)


def run_tnet3_pump():
    sim = tnet3_sim('cmp_tnet3_pump')
    sim.define_pump_operation('PUMP-172', initial_setting=1, final_setting=0, start_time=1, end_time=3)
    sim.run()
    return dump(sim, TNET3_NODES + ['217-A', '217-B'], TNET3_PIPES)


def run_tnet3_burst():
    sim = tnet3_sim('cmp_tnet3_burst')
    sim.add_burst('JUNCTION-73', burst_coeff=0.05, start_time=1, end_time=2)
    sim.run()
    return dump(sim, TNET3_NODES, TNET3_PIPES)


def run_hammer_custom():
    p = write_inp(HAMMER_INP, 'hammer.inp')
    sim = PTSNETSimulation(workspace_name='cmp_hammer_custom', inpfile=p, settings={
        'duration': 4.0, 'time_step': 0.05, 'default_wave_speed': 1000,
        'wave_speed_method': 'user', 'save_results': False})
    sim.define_valve_settings('V1', [0.5, 0.7, 0.9], [0.8, 0.4, 0.0])
    sim.run()
    return dump(sim)


def run_simple_demand():
    p = write_inp(SIMPLE_INP, 'simple.inp')
    sim = PTSNETSimulation(workspace_name='cmp_simple_demand', inpfile=p, settings={
        'duration': 1.0, 'time_step': 0.05, 'default_wave_speed': 1000,
        'wave_speed_method': 'user', 'save_results': False})
    sim.define_demand_settings('J1', [0.3, 0.6], [0.005, 0.02])
    sim.run()
    return dump(sim)


if __name__ == '__main__':
    results = {}
    scenarios = [
        ('simple', run_simple), ('hammer', run_hammer), ('tnet3', run_tnet3),
        ('tnet3_pump', run_tnet3_pump), ('tnet3_burst', run_tnet3_burst),
        ('hammer_custom', run_hammer_custom), ('simple_demand', run_simple_demand),
    ]
    for name, fn in scenarios:
        print('running', name, '...', flush=True)
        results[name] = fn()
        r = results[name]
        print('  time_step=%.6g time_steps=%d num_points=%d' % (r['time_step'], r['time_steps'], r['num_points']))
    with open(os.path.join(HERE, 'python_results.json'), 'w') as f:
        json.dump(results, f)
    print('wrote', os.path.join(HERE, 'python_results.json'))
